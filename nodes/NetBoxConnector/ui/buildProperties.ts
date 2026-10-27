import type { INodeProperties } from 'n8n-workflow';

import { OPERATIONS, RESOURCES } from '../catalog/operations.generated';
import type { ApiOperation } from '../catalog/types';
import { buildCustomProperties } from './customProperties';
import { buildGraphqlProperties } from './graphqlProperties';
import { buildHelperProperties } from './helperProperties';

function displayFor(operation: ApiOperation): INodeProperties['displayOptions'] {
	return { show: { resource: [operation.resource], operation: [operation.id] } };
}

function property(
	displayName: string,
	name: string,
	type: INodeProperties['type'],
	operation: ApiOperation,
	options: Partial<INodeProperties> = {},
): INodeProperties {
	return { displayName, name, type, default: '', displayOptions: displayFor(operation), ...options };
}

function hasBinaryBody(operation: ApiOperation): boolean {
	return (operation.requestBody?.contentTypes ?? []).some(media => media.binaryFields.length > 0);
}

function hasBinaryResponse(operation: ApiOperation): boolean {
	return operation.responses.some(response => response.statusCode.startsWith('2') && (
		response.contentType.startsWith('image/') ||
		response.contentType.startsWith('application/octet-stream') ||
		response.contentType.startsWith('application/pdf') ||
		(!response.contentType.includes('json') &&
			!response.contentType.includes('xml') &&
			!response.contentType.startsWith('text/') &&
			response.contentType !== '')
	));
}

export function buildCatalogProperties(): INodeProperties[] {
	const properties: INodeProperties[] = [
		{
			displayName: 'Resource',
			name: 'resource',
			type: 'options',
			noDataExpression: true,
			options: RESOURCES.map(resource => ({ name: resource.label, value: resource.value })),
			default: RESOURCES[0]?.value ?? '',
		},
	];
	const operationIds = OPERATIONS.map(operation => operation.id);

	for (const resource of RESOURCES) {
		const operations = OPERATIONS.filter(operation => operation.resource === resource.value);
		const defaultOperation =
			operations.find(operation => operation.method === 'GET' && operation.paginated && !operation.deprecated) ??
			operations.find(operation => operation.method === 'GET' && !operation.deprecated) ??
			operations.find(operation => !operation.deprecated) ??
			operations[0];
		properties.push({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			options: operations.map(operation => ({ name: operation.label, value: operation.id, description: operation.summary })),
			default: defaultOperation?.id ?? '',
			displayOptions: { show: { resource: [resource.value] } },
		});
	}

	for (const operation of OPERATIONS) {
		for (const parameter of operation.pathParameters) {
			properties.push(property(parameter.name, `path_${operation.id}_${parameter.name}`, parameter.kind === 'number' ? 'number' : 'string', operation, {
				required: true,
				description: parameter.description ?? `Required path parameter for ${operation.method} ${operation.path}.`,
			}));
		}
	}

	properties.push(
		{
			displayName: 'Query Parameters',
			name: 'queryParameters',
			type: 'json',
			default: {},
			displayOptions: { show: { operation: operationIds } },
			description: 'JSON object of query parameters and filters. Values are serialized using the operation parameter styles.',
		},
		{
			displayName: 'Headers',
			name: 'headers',
			type: 'json',
			default: {},
			displayOptions: { show: { operation: operationIds } },
			description: 'Additional HTTP headers as a JSON object',
		},
	);

	const bodyGroups = new Map<string, ApiOperation[]>();
	for (const operation of OPERATIONS.filter(entry => entry.requestBody !== undefined)) {
		const contentTypes = operation.requestBody?.contentTypes.map(media => media.contentType).sort() ?? [];
		const binary = hasBinaryBody(operation);
		const key = `${binary}:${contentTypes.join(',')}`;
		const group = bodyGroups.get(key) ?? [];
		group.push(operation);
		bodyGroups.set(key, group);
	}
	for (const operations of bodyGroups.values()) {
		const representative = operations[0];
		const contentTypes = representative.requestBody?.contentTypes ?? [];
		const supportsJson = contentTypes.some(media => media.contentType === 'application/json');
		const supportsMultipart = contentTypes.some(media => media.contentType === 'multipart/form-data');
		const multipartDefault = hasBinaryBody(representative) && supportsMultipart;
		const operationIdsForBody = operations.map(operation => operation.id);
		const bodyFormats = [
			...(supportsJson ? [{ name: 'JSON', value: 'json' }] : []),
			...(supportsMultipart ? [{ name: 'Multipart', value: 'multipart' }] : []),
		];
		properties.push(
			{
				displayName: 'Body Format',
				name: 'bodyFormat',
				type: 'options',
				options: bodyFormats,
				default: multipartDefault ? 'multipart' : supportsJson ? 'json' : bodyFormats[0]?.value ?? '',
				displayOptions: { show: { operation: operationIdsForBody } },
				description: 'Pass JSON values unchanged, including arrays, scalars, and null',
			},
			{
				displayName: 'Body',
				name: 'body',
				type: 'json',
				default: {},
				displayOptions: { show: { operation: operationIdsForBody } },
				description: multipartDefault ? 'For multipart, provide the text-field map as JSON.' : 'Request JSON body; objects, arrays, scalars and null are passed unchanged.',
			},
		);
		if (multipartDefault) {
			properties.push({
				displayName: 'Binary Fields',
				name: 'binaryFields',
				type: 'fixedCollection',
				default: {},
				placeholder: 'Add Binary Field',
				typeOptions: { multipleValues: true },
				options: [{
					name: 'mapping',
					displayName: 'Mapping',
					values: [
						{ displayName: 'Field Name', name: 'fieldName', type: 'string', default: '' },
						{ displayName: 'Input Binary Field', name: 'inputBinaryField', type: 'string', default: 'data' },
					],
				}],
				displayOptions: { show: { operation: operationIdsForBody } },
				description: 'Map a multipart field name to an input item binary property. Repeat a fieldName to send multiple files.',
			});
		}
	}

	const projectionOperations = OPERATIONS.filter(operation =>
		operation.queryParameters.some(parameter => ['fields', 'omit', 'brief', 'ordering'].includes(parameter.name)));
	if (projectionOperations.length > 0) {
		properties.push({
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			default: {},
			placeholder: 'Add Option',
			displayOptions: { show: { operation: projectionOperations.map(operation => operation.id) } },
			options: [{
				name: 'values',
				displayName: 'Options',
				values: [
					{ displayName: 'Fields', name: 'fields', type: 'string', default: '' },
					{ displayName: 'Omit', name: 'omit', type: 'string', default: '' },
					{ displayName: 'Brief', name: 'brief', type: 'boolean', default: false },
					{ displayName: 'Ordering', name: 'ordering', type: 'string', default: '' },
				],
			}],
			description: 'NetBox projection and ordering controls. When both Fields and Omit are supplied, Fields takes precedence.',
		});
	}

	const paginatedIds = OPERATIONS.filter(operation => operation.paginated).map(operation => operation.id);
	const binaryResponseIds = OPERATIONS.filter(hasBinaryResponse).map(operation => operation.id);
	properties.push(
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions: { show: { operation: paginatedIds, includeResponseMetadata: [false] } },
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			description: 'Max number of results to return',
			displayOptions: { show: { operation: paginatedIds, returnAll: [false], includeResponseMetadata: [false] } },
		},
		{
			displayName: 'Page Size',
			name: 'pageSize',
			type: 'number',
			default: 100,
			typeOptions: { minValue: 1 },
			displayOptions: { show: { operation: paginatedIds, includeResponseMetadata: [false] } },
		},
		{
			displayName: 'Include Response Metadata',
			name: 'includeResponseMetadata',
			type: 'boolean',
			default: false,
			displayOptions: { show: { operation: operationIds } },
			description: 'Whether to return one item containing the raw body, status code, and response headers',
		},
		{
			displayName: 'Timeout',
			name: 'timeout',
			type: 'number',
			default: 30000,
			typeOptions: { minValue: 1 },
			displayOptions: { show: { operation: operationIds } },
			description: 'Request timeout in milliseconds',
		},
		{
			displayName: 'Output Binary Field',
			name: 'outputBinaryField',
			type: 'string',
			default: 'data',
			displayOptions: { show: { operation: binaryResponseIds } },
		},
	);
	return properties;
}
export function buildProperties(): INodeProperties[] {
	const resources = [
		...RESOURCES,
		{ value: 'customApi', label: 'Custom REST' },
		{ value: 'graphql', label: 'GraphQL' },
		{ value: 'helpers', label: 'Helpers' },
	];
	const defaultResource = RESOURCES.some(resource => resource.value === 'dcim/devices')
		? 'dcim/devices'
		: RESOURCES[0]?.value ?? 'customApi';
	return [
		{
			displayName: 'Resource',
			name: 'resource',
			type: 'options',
			noDataExpression: true,
			options: resources.map(resource => ({ name: resource.label, value: resource.value })),
			default: defaultResource,
		},
		...buildCatalogProperties().filter(entry => entry.name !== 'resource'),
		...buildCustomProperties(),
		...buildGraphqlProperties(),
		...buildHelperProperties(),
	];
}
