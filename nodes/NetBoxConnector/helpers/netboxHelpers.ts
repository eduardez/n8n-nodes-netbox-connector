import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { NetBoxClient, NetBoxResponse } from '../transport/NetBoxClient';
import { isRecord } from '../utils/typeGuards';

function fail(context: IExecuteFunctions, itemIndex: number, message: string): never {
	throw new NodeOperationError(context.getNode(), message, { itemIndex });
}

function positiveId(context: IExecuteFunctions, itemIndex: number, name: string): number {
	const value = context.getNodeParameter(name, itemIndex);
	const id = typeof value === 'number' ? value : Number(value);
	if (!Number.isSafeInteger(id) || id <= 0) fail(context, itemIndex, `${name} must be a positive safe integer.`);
	return id;
}

function requestList(
	context: IExecuteFunctions,
	itemIndex: number,
	name: string,
	value: unknown,
): Array<Record<string, unknown>> {
	let parsed = value;
	if (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			fail(context, itemIndex, `${name} must contain valid JSON.`);
		}
	}
	if (!Array.isArray(parsed)) fail(context, itemIndex, `${name} must be a JSON array of objects.`);
	const requests: Array<Record<string, unknown>> = [];
	for (const [index, entry] of parsed.entries()) {
		if (!isRecord(entry)) fail(context, itemIndex, `${name} entry ${index} must be a JSON object.`);
		requests.push(entry);
	}
	return requests;
}

function responseItems(response: NetBoxResponse, metadata: boolean): INodeExecutionData[] {
	if (metadata) {
		return [{ json: { body: response.body, statusCode: response.statusCode, headers: response.headers } as IDataObject }];
	}
	if (Array.isArray(response.body)) {
		return response.body.map(value => ({ json: (isRecord(value) ? value : { value }) as IDataObject }));
	}
	if (isRecord(response.body)) return [{ json: response.body as IDataObject }];
	return [{ json: { value: response.body } as IDataObject }];
}

export async function executeNetBoxHelper(
	context: IExecuteFunctions,
	client: NetBoxClient,
	itemIndex: number,
	operationId: string,
): Promise<INodeExecutionData[]> {
	const timeoutValue = context.getNodeParameter('timeout', itemIndex, 30000);
	const timeout = typeof timeoutValue === 'number' ? timeoutValue : Number(timeoutValue);
	if (!Number.isSafeInteger(timeout) || timeout <= 0) fail(context, itemIndex, 'Timeout must be a positive safe integer.');
	const includeMetadata = context.getNodeParameter('includeResponseMetadata', itemIndex, false) === true;
	let method: 'GET' | 'POST' | 'PATCH';
	let path: string;
	let body: unknown;

	switch (operationId) {
		case 'availableIps':
		case 'allocateIp': {
			const parentType = context.getNodeParameter('parentType', itemIndex);
			if (parentType !== 'prefix' && parentType !== 'ipRange') {
				fail(context, itemIndex, 'Parent Type must be Prefix or IP Range.');
			}
			const parentId = positiveId(context, itemIndex, 'parentId');
			path = parentType === 'prefix'
				? `/api/ipam/prefixes/${parentId}/available-ips/`
				: `/api/ipam/ip-ranges/${parentId}/available-ips/`;
			if (operationId === 'availableIps') {
				method = 'GET';
			} else {
				method = 'POST';
				const requestBody = requestList(context, itemIndex, 'Request Body', context.getNodeParameter('requestBody', itemIndex, []));
				if (requestBody.length === 0) fail(context, itemIndex, 'Request Body must include at least one IP allocation request.');
				body = requestBody;
				for (const [index, entry] of requestBody.entries()) {
					if (entry.prefix_length !== undefined && !Number.isSafeInteger(entry.prefix_length)) {
						fail(context, itemIndex, `Request Body entry ${index} prefix_length must be a safe integer.`);
					}
				}
			}
			break;
		}
		case 'availablePrefixes': {
			const prefixId = positiveId(context, itemIndex, 'prefixId');
			method = 'GET';
			path = `/api/ipam/prefixes/${prefixId}/available-prefixes/`;
			break;
		}
		case 'allocatePrefix': {
			const prefixId = positiveId(context, itemIndex, 'prefixId');
			const requestBody = requestList(context, itemIndex, 'Request Body', context.getNodeParameter('requestBody', itemIndex, []));
			body = requestBody;
			if (requestBody.length === 0) fail(context, itemIndex, 'Request Body must include at least one prefix allocation request.');
			for (const [index, entry] of requestBody.entries()) {
				if (!Number.isSafeInteger(entry.prefix_length)) {
					fail(context, itemIndex, `Request Body entry ${index} must include a safe-integer prefix_length.`);
				}
			}
			method = 'POST';
			path = `/api/ipam/prefixes/${prefixId}/available-prefixes/`;
			break;
		}
		case 'assignIpToInterface': {
			const ipId = positiveId(context, itemIndex, 'ipId');
			const interfaceId = positiveId(context, itemIndex, 'interfaceId');
			method = 'PATCH';
			path = `/api/ipam/ip-addresses/${ipId}/`;
			body = { assigned_object_type: 'dcim.interface', assigned_object_id: interfaceId };
			break;
		}
		default:
			fail(context, itemIndex, `Unsupported helper operation "${operationId}".`);
	}

	const response = await client.request({ method, path, body, bodyFormat: body === undefined ? undefined : 'json', responseFormat: 'json', timeout });
	return responseItems(response, includeMetadata);
}
