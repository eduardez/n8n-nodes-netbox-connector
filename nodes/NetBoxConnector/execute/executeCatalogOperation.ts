import FormData from 'form-data';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { ApiOperation, ApiParameter } from '../catalog/types';
import type { NetBoxClient, NetBoxResponse, QuerySerialization } from '../transport/NetBoxClient';
import { isRecord } from '../utils/typeGuards';
import { fetchPaginatedList } from './pagination';

function fail(context: IExecuteFunctions, itemIndex: number, message: string): never {
	throw new NodeOperationError(context.getNode(), message, { itemIndex });
}


function readJsonObject(
	context: IExecuteFunctions,
	itemIndex: number,
	name: string,
	value: unknown,
): Record<string, unknown> {
	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			fail(context, itemIndex, `${name} must contain valid JSON.`);
		}
	}
	if (!isRecord(parsed)) fail(context, itemIndex, `${name} must be a JSON object.`);
	return parsed;
}

function parameterValue(
	context: IExecuteFunctions,
	itemIndex: number,
	parameter: ApiParameter,
	value: unknown,
): unknown {
	if (value === undefined && parameter.required) {
		fail(context, itemIndex, `Required ${parameter.location} parameter "${parameter.name}" is missing.`);
	}
	return value;
}


function responseFormatFor(operation: ApiOperation): 'json' | 'text' | 'binary' {
	const contentTypes = operation.responses
		.filter(response => response.statusCode.startsWith('2'))
		.map(response => response.contentType);
	if (contentTypes.some(type => type.startsWith('image/') || type.startsWith('application/octet-stream') ||
		type.startsWith('application/pdf') || (!type.includes('json') && !type.includes('xml') && !type.startsWith('text/') && type !== ''))) {
		return 'binary';
	}
	return contentTypes.some(type => type.startsWith('text/')) ? 'text' : 'json';
}

function getHeader(headers: Record<string, unknown>, name: string): string | undefined {
	const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
	return typeof found === 'string' ? found : undefined;
}

function fileNameFromHeaders(headers: Record<string, unknown>): string | undefined {
	const disposition = getHeader(headers, 'content-disposition');
	if (disposition === undefined) return undefined;
	const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
	if (encoded) {
		try {
			return decodeURIComponent(encoded.replace(/^"|"$/g, ''));
		} catch {
			return undefined;
		}
	}
	return disposition.match(/filename="?([^";]+)"?/i)?.[1];
}

function responseBody(response: NetBoxResponse, method: string): unknown {
	if (response.statusCode === 204 || method === 'HEAD') return {};
	return response.body;
}

function outputValues(body: unknown): unknown[] {
	if (Array.isArray(body)) return body;
	if (isRecord(body)) return [body];
	if (body === undefined || body === null) return [{ value: body }];
	return [{ value: body }];
}

function normalizeHeaders(
	context: IExecuteFunctions,
	itemIndex: number,
	input: unknown,
	parameters: ApiParameter[],
): Record<string, string> {
	const source = readJsonObject(context, itemIndex, 'Headers', input);
	for (const parameter of parameters) {
		if (parameter.required && !Object.entries(source).some(([name, value]) =>
			name.toLowerCase() === parameter.name.toLowerCase() && value !== undefined)) {
			fail(context, itemIndex, `Required header parameter "${parameter.name}" is missing.`);
		}
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (value === null || typeof value === 'object') {
			fail(context, itemIndex, `Header "${name}" must be a non-null scalar value.`);
		}
		headers[name] = String(value);
	}
	return headers;
}

function normalizeQuery(
	context: IExecuteFunctions,
	itemIndex: number,
	input: unknown,
	parameters: ApiParameter[],
): { query: Record<string, unknown>; serialization: Record<string, QuerySerialization> } {
	const query = readJsonObject(context, itemIndex, 'Query Parameters', input);
	const serialization: Record<string, QuerySerialization> = {};
	for (const parameter of parameters) {
		if (parameter.required &&
			(!Object.prototype.hasOwnProperty.call(query, parameter.name) || query[parameter.name] === undefined)) {
			fail(context, itemIndex, `Required query parameter "${parameter.name}" is missing.`);
		}
		if (parameter.style !== undefined || parameter.explode !== undefined) {
			serialization[parameter.name] = { style: parameter.style, explode: parameter.explode };
		}
	}
	return { query, serialization };
}

function optionValues(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	if (isRecord(value.values)) return value.values;
	return value;
}

function applyOptions(query: Record<string, unknown>, input: unknown): void {
	const options = optionValues(input);
	const fieldsPresent = Object.prototype.hasOwnProperty.call(options, 'fields');
	const omitPresent = Object.prototype.hasOwnProperty.call(options, 'omit');
	if (fieldsPresent) query.fields = options.fields;
	else if (omitPresent) query.omit = options.omit;
	for (const name of ['brief', 'ordering']) {
		if (Object.prototype.hasOwnProperty.call(options, name)) query[name] = options[name];
	}
}


function binaryMappings(value: unknown): Array<{ fieldName: string; inputBinaryField: string }> {
	if (!isRecord(value)) return [];
	const mappings = value.mapping;
	const entries = Array.isArray(mappings) ? mappings : isRecord(mappings) ? [mappings] : [];
	return entries.filter(isRecord).map(entry => ({
		fieldName: String(entry.fieldName ?? ''),
		inputBinaryField: String(entry.inputBinaryField ?? 'data'),
	}));
}

function appendMultipartText(form: FormData, values: Record<string, unknown>): void {
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) continue;
		const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : value === null ? 'null' : String(value);
		form.append(name, text);
	}
}

function requiredBinaryFields(operation: ApiOperation): string[] {
	const media = operation.requestBody?.contentTypes.find(entry => entry.contentType === 'multipart/form-data');
	return media?.requiredBinaryFields ?? [];
}

async function makeMultipartBody(
	context: IExecuteFunctions,
	itemIndex: number,
	item: INodeExecutionData,
	operation: ApiOperation,
	bodyValue: unknown,
	mappingValue: unknown,
): Promise<FormData> {
	const form = new FormData();
	appendMultipartText(form, readJsonObject(context, itemIndex, 'Multipart text fields', bodyValue));
	const mappings = binaryMappings(mappingValue);
	const mappedNames = new Set(mappings.map(mapping => mapping.fieldName));
	for (const fieldName of requiredBinaryFields(operation)) {
		if (!mappedNames.has(fieldName)) fail(context, itemIndex, `Required binary field "${fieldName}" has no input mapping.`);
	}
	for (const mapping of mappings) {
		if (mapping.fieldName === '') fail(context, itemIndex, 'Multipart fieldName must not be empty.');
		const binary = item.binary?.[mapping.inputBinaryField];
		if (!binary) fail(context, itemIndex, `Input binary field "${mapping.inputBinaryField}" is missing.`);
		const buffer = await context.helpers.getBinaryDataBuffer(itemIndex, mapping.inputBinaryField);
		form.append(mapping.fieldName, buffer, {
			filename: binary.fileName ?? mapping.inputBinaryField,
			contentType: binary.mimeType ?? 'application/octet-stream',
		});
	}
	return form;
}

function pathForOperation(
	context: IExecuteFunctions,
	itemIndex: number,
	operation: ApiOperation,
): string {
	return operation.path.replace(/\{([^}]+)\}/g, (match, name: string) => {
		const parameter = operation.pathParameters.find(entry => entry.name === name);
		if (!parameter) fail(context, itemIndex, `Catalog path parameter "${name}" is not declared for ${operation.id}.`);
		const value = parameterValue(
			context,
			itemIndex,
			parameter,
			context.getNodeParameter(`path_${operation.id}_${name}`, itemIndex, undefined),
		);
		if (value === undefined || value === null || value === '') {
			fail(context, itemIndex, `Required path parameter "${name}" is missing.`);
		}
		return encodeURIComponent(String(value));
	});
}

export async function executeCatalogOperation(
	context: IExecuteFunctions,
	client: NetBoxClient,
	itemIndex: number,
	item: INodeExecutionData,
	operation: ApiOperation,
): Promise<INodeExecutionData[]> {
	const path = pathForOperation(context, itemIndex, operation);
	const { query, serialization } = normalizeQuery(
		context,
		itemIndex,
		context.getNodeParameter('queryParameters', itemIndex, {}),
		operation.queryParameters,
	);
	const headers = normalizeHeaders(
		context,
		itemIndex,
		context.getNodeParameter('headers', itemIndex, {}),
		operation.headerParameters,
	);
	applyOptions(query, context.getNodeParameter('options', itemIndex, {}));
	const includeMetadata = context.getNodeParameter('includeResponseMetadata', itemIndex, false) === true;
	const returnAll = context.getNodeParameter('returnAll', itemIndex, false) === true;
	if (includeMetadata && (
		returnAll ||
		query.returnAll === true ||
		query.pagination === true
	)) {
		fail(context, itemIndex, 'Include Response Metadata cannot be combined with automatic pagination.');
	}
	const timeoutValue = context.getNodeParameter('timeout', itemIndex, 30000);
	const timeout = Number(timeoutValue);
	if (!Number.isSafeInteger(timeout) || timeout <= 0) fail(context, itemIndex, 'Timeout must be a positive safe integer.');

	if (operation.paginated && !includeMetadata) {
		const limit = Number(context.getNodeParameter('limit', itemIndex, 50));
		const pageSize = Number(context.getNodeParameter('pageSize', itemIndex, 100));
		if (!Number.isSafeInteger(limit) || limit <= 0) fail(context, itemIndex, 'Limit must be a positive safe integer.');
		if (!Number.isSafeInteger(pageSize) || pageSize <= 0) fail(context, itemIndex, 'Page Size must be a positive safe integer.');
		const results = await fetchPaginatedList(client, path, query, {
			returnAll,
			limit,
			pageSize,
			headers,
			timeout,
			querySerialization: serialization,
		});
		return results.map(value => ({ json: (isRecord(value) ? value : { value }) as IDataObject }));
	}

	let body: unknown;
	let bodyFormat: 'json' | 'multipart' | undefined;
	if (operation.requestBody !== undefined) {
		const selectedFormat = context.getNodeParameter('bodyFormat', itemIndex, 'json');
		if (selectedFormat === 'multipart') {
			if (!operation.requestBody.contentTypes.some(media => media.contentType === 'multipart/form-data')) {
				fail(context, itemIndex, 'Multipart is not supported by this operation.');
			}
			body = await makeMultipartBody(
				context,
				itemIndex,
				item,
				operation,
				context.getNodeParameter('body', itemIndex, {}),
				context.getNodeParameter('binaryFields', itemIndex, {}),
			);
			bodyFormat = 'multipart';
		} else if (selectedFormat === 'json') {
			let requestBody = context.getNodeParameter('body', itemIndex, {});
			if (operation.requestBody.required && requestBody === undefined) {
				fail(context, itemIndex, 'This operation requires a request body.');
			}
			if (typeof requestBody === 'string') {
				try {
					requestBody = JSON.parse(requestBody);
				} catch {
					fail(context, itemIndex, 'Body must contain valid JSON.');
				}
			}
			body = requestBody;
			bodyFormat = 'json';
		} else {
			fail(context, itemIndex, 'Body Format must be JSON or Multipart.');
		}
	}
	const responseFormat = responseFormatFor(operation);
	const response = await client.request({
		method: operation.method,
		path,
		query,
		querySerialization: serialization,
		headers,
		...(bodyFormat === undefined ? {} : { body, bodyFormat }),
		responseFormat,
		timeout,
	});
	const binary = responseFormat === 'binary' || Buffer.isBuffer(response.body) || response.body instanceof Uint8Array;
	let binaryProperty: INodeExecutionData['binary'];
	let normalizedBody = responseBody(response, operation.method);
	if (binary && response.statusCode !== 204 && operation.method !== 'HEAD') {
		const buffer = Buffer.isBuffer(response.body)
			? response.body
			: response.body instanceof Uint8Array
				? Buffer.from(response.body)
				: typeof response.body === 'string'
					? Buffer.from(response.body)
					: Buffer.from('');
		const outputField = String(context.getNodeParameter('outputBinaryField', itemIndex, 'data') || 'data');
		const mimeType = getHeader(response.headers, 'content-type')?.split(';', 1)[0] || 'application/octet-stream';
		binaryProperty = {
			[outputField]: await context.helpers.prepareBinaryData(buffer, fileNameFromHeaders(response.headers), mimeType),
		};
		normalizedBody = includeMetadata ? null : {};
	}
	if (includeMetadata) {
		return [{
			json: { body: binary ? normalizedBody : response.body ?? null, statusCode: response.statusCode, headers: response.headers } as IDataObject,
			...(binaryProperty ? { binary: binaryProperty } : {}),
		}];
	}
	return outputValues(normalizedBody).map(value => ({
		json: (isRecord(value) ? value : { value }) as IDataObject,
		...(binaryProperty ? { binary: binaryProperty } : {}),
	}));
}
