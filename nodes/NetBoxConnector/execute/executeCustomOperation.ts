import FormData from 'form-data';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { NetBoxClient, NetBoxMethod, NetBoxResponse, NetBoxResponseFormat } from '../transport/NetBoxClient';
import { NetBoxHttpError } from '../transport/NetBoxClient';
import { isRecord } from '../utils/typeGuards';

function fail(context: IExecuteFunctions, itemIndex: number, message: string): never {
	throw new NodeOperationError(context.getNode(), message, { itemIndex });
}

function parseJson(context: IExecuteFunctions, itemIndex: number, name: string, value: unknown): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return fail(context, itemIndex, `${name} must contain valid JSON.`);
	}
}

function jsonObject(context: IExecuteFunctions, itemIndex: number, name: string, value: unknown): Record<string, unknown> {
	const parsed = parseJson(context, itemIndex, name, value);
	if (!isRecord(parsed)) fail(context, itemIndex, `${name} must be a JSON object.`);
	return parsed;
}

function normalizeHeaders(context: IExecuteFunctions, itemIndex: number, value: unknown): Record<string, string> {
	const source = jsonObject(context, itemIndex, 'Headers', value);
	const headers: Record<string, string> = {};
	for (const [name, entry] of Object.entries(source)) {
		if (entry === undefined) continue;
		if (entry === null || (typeof entry === 'object' && entry !== null)) {
			fail(context, itemIndex, `Header "${name}" must be a scalar value.`);
		}
		headers[name] = String(entry);
	}
	return headers;
}

function mappings(value: unknown): Array<{ fieldName: string; inputBinaryField: string }> {
	if (!isRecord(value)) return [];
	const raw = value.mapping;
	const values = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
	return values.filter(isRecord).map(entry => ({
		fieldName: String(entry.fieldName ?? ''),
		inputBinaryField: String(entry.inputBinaryField ?? 'data'),
	}));
}

function fileNameFromHeaders(headers: Record<string, unknown>): string | undefined {
	const disposition = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-disposition')?.[1];
	if (typeof disposition !== 'string') return undefined;
	const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
	if (encoded) {
		try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')); } catch { return undefined; }
	}
	return disposition.match(/filename="?([^";]+)"?/i)?.[1];
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
	const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
	return typeof value === 'string' ? value : undefined;
}

function outputItems(body: unknown): INodeExecutionData[] {
	const values = Array.isArray(body) ? body : [body];
	return values.map(value => ({ json: (isRecord(value) ? value : { value }) as IDataObject }));
}

export async function executeCustomOperation(
	context: IExecuteFunctions,
	client: NetBoxClient,
	itemIndex: number,
	item: INodeExecutionData,
): Promise<INodeExecutionData[]> {
	const methodValue = context.getNodeParameter('method', itemIndex, 'GET');
	const methods: NetBoxMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
	if (typeof methodValue !== 'string' || !methods.includes(methodValue as NetBoxMethod)) {
		fail(context, itemIndex, 'Method must be GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS.');
	}
	const method = methodValue as NetBoxMethod;
	const path = context.getNodeParameter('path', itemIndex, '/api/');
	if (typeof path !== 'string' || path.trim() === '') fail(context, itemIndex, 'API path must be a non-empty /api/-relative path.');
	const query = jsonObject(context, itemIndex, 'Query Parameters', context.getNodeParameter('queryParameters', itemIndex, {}));
	const headers = normalizeHeaders(context, itemIndex, context.getNodeParameter('headers', itemIndex, {}));
	const formatValue = context.getNodeParameter('bodyType', itemIndex, 'none');
	const bodyTypes = ['none', 'json', 'raw', 'formUrlencoded', 'multipart', 'binary'];
	if (typeof formatValue !== 'string' || !bodyTypes.includes(formatValue)) fail(context, itemIndex, 'Body Type is invalid.');
	const bodyType = formatValue;
	if ((method === 'GET' || method === 'HEAD') && bodyType !== 'none') {
		fail(context, itemIndex, `${method} requests cannot include a body.`);
	}
	let body: unknown;
	let bodyFormat: 'json' | 'raw' | 'formUrlEncoded' | 'multipart' | 'binary' | undefined;
	if (bodyType === 'json') {
		body = parseJson(context, itemIndex, 'Body', context.getNodeParameter('body', itemIndex, {}));
		bodyFormat = 'json';
	} else if (bodyType === 'raw') {
		const contentType = context.getNodeParameter('rawContentType', itemIndex, 'text/plain');
		const raw = context.getNodeParameter('rawBody', itemIndex, '');
		if (typeof raw !== 'string') fail(context, itemIndex, 'Raw Body must be text.');
		if (typeof contentType !== 'string' || contentType.trim() === '') fail(context, itemIndex, 'Raw Content Type must be non-empty.');
		body = raw;
		bodyFormat = 'raw';
		headers['Content-Type'] = contentType;
	} else if (bodyType === 'formUrlencoded') {
		const fields = jsonObject(context, itemIndex, 'Form Fields', context.getNodeParameter('formFields', itemIndex, {}));
		const params = new URLSearchParams();
		for (const [name, value] of Object.entries(fields)) {
			if (value === undefined) continue;
			if (Array.isArray(value)) {
				for (const entry of value) {
					if (entry !== null && typeof entry === 'object') fail(context, itemIndex, `Form field "${name}" must contain scalar values.`);
					params.append(name, entry === null ? 'null' : String(entry));
				}
			} else {
				if (value !== null && typeof value === 'object') fail(context, itemIndex, `Form field "${name}" must be scalar or an array of scalars.`);
				params.append(name, value === null ? 'null' : String(value));
			}
		}
		body = params;
		bodyFormat = 'formUrlEncoded';
	} else if (bodyType === 'multipart') {
		const textFields = jsonObject(context, itemIndex, 'Multipart Text Fields', context.getNodeParameter('multipartFields', itemIndex, {}));
		const form = new FormData();
		for (const [name, value] of Object.entries(textFields)) {
			if (value === undefined) continue;
			form.append(name, value !== null && typeof value === 'object' ? JSON.stringify(value) : value === null ? 'null' : String(value));
		}
		for (const mapping of mappings(context.getNodeParameter('binaryFields', itemIndex, {}))) {
			if (!mapping.fieldName) fail(context, itemIndex, 'Multipart Field Name must not be empty.');
			if (!item.binary?.[mapping.inputBinaryField]) fail(context, itemIndex, `Input binary field "${mapping.inputBinaryField}" is missing.`);
			const buffer = await context.helpers.getBinaryDataBuffer(itemIndex, mapping.inputBinaryField);
			const metadata = item.binary[mapping.inputBinaryField];
			form.append(mapping.fieldName, buffer, {
				filename: metadata.fileName ?? mapping.inputBinaryField,
				contentType: metadata.mimeType ?? 'application/octet-stream',
			});
		}
		body = form;
		bodyFormat = 'multipart';
	} else if (bodyType === 'binary') {
		const inputField = String(context.getNodeParameter('inputBinaryField', itemIndex, 'data'));
		if (!inputField || !item.binary?.[inputField]) fail(context, itemIndex, `Input binary field "${inputField}" is missing.`);
		body = await context.helpers.getBinaryDataBuffer(itemIndex, inputField);
		bodyFormat = 'binary';
		const mimeType = item.binary[inputField].mimeType;
		if (mimeType) headers['Content-Type'] = mimeType;
	}
	const responseValue = context.getNodeParameter('responseFormat', itemIndex, 'json');
	if (!['json', 'text', 'binary'].includes(String(responseValue))) fail(context, itemIndex, 'Response Format must be JSON, Text, or Binary.');
	const responseFormat = responseValue as NetBoxResponseFormat;
	const metadata = context.getNodeParameter('includeResponseMetadata', itemIndex, false) === true;
	const timeout = Number(context.getNodeParameter('timeout', itemIndex, 30000));
	if (!Number.isSafeInteger(timeout) || timeout <= 0) fail(context, itemIndex, 'Timeout must be a positive safe integer.');
	let response: NetBoxResponse;
	try {
		response = await client.request({
			method,
			path: path as string,
			query,
			headers,
			...(bodyFormat === undefined ? {} : { body, bodyFormat }),
			responseFormat,
			timeout,
		});
	} catch (caught) {
		if (caught instanceof NetBoxHttpError || caught instanceof NodeOperationError) throw caught;
		fail(context, itemIndex, caught instanceof Error ? caught.message : String(caught));
	}
	const isBinary = responseFormat === 'binary' || Buffer.isBuffer(response.body) || response.body instanceof Uint8Array;
	let binary: INodeExecutionData['binary'];
	let bodyValue: unknown = response.statusCode === 204 || method === 'HEAD' ? {} : response.body;
	if (isBinary && response.statusCode !== 204 && method !== 'HEAD') {
		const buffer = Buffer.isBuffer(response.body) ? response.body : response.body instanceof Uint8Array ? Buffer.from(response.body) : Buffer.from(typeof response.body === 'string' ? response.body : '');
		const outputField = String(context.getNodeParameter('outputBinaryField', itemIndex, 'data') || 'data');
		const mimeType = headerValue(response.headers, 'content-type')?.split(';', 1)[0] || 'application/octet-stream';
		binary = { [outputField]: await context.helpers.prepareBinaryData(buffer, fileNameFromHeaders(response.headers), mimeType) };
		bodyValue = metadata ? null : {};
	}
	if (metadata) {
		return [{ json: { body: isBinary ? null : bodyValue ?? null, statusCode: response.statusCode, headers: response.headers } as IDataObject, ...(binary ? { binary } : {}) }];
	}
	return outputItems(bodyValue).map(output => ({ ...output, ...(binary ? { binary } : {}) }));
}
