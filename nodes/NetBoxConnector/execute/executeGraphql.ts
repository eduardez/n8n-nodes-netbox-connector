import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { parse, type DocumentNode } from 'graphql';

import type { NetBoxClient } from '../transport/NetBoxClient';
import { isRecord } from '../utils/typeGuards';

function fail(context: IExecuteFunctions, itemIndex: number, message: string): never {
	throw new NodeOperationError(context.getNode(), message, { itemIndex });
}

function variablesObject(
	context: IExecuteFunctions,
	itemIndex: number,
	value: unknown,
): Record<string, unknown> {
	let variables = value;
	if (typeof value === 'string') {
		try {
			variables = JSON.parse(value);
		} catch {
			fail(context, itemIndex, 'Variables must contain valid JSON.');
		}
	}
	if (!isRecord(variables)) fail(context, itemIndex, 'Variables must be a JSON object.');
	return variables;
}

export async function executeGraphql(
	context: IExecuteFunctions,
	client: NetBoxClient,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const queryValue = context.getNodeParameter('query', itemIndex);
	if (typeof queryValue !== 'string' || queryValue.trim() === '') {
		fail(context, itemIndex, 'Query must be a non-empty GraphQL document.');
	}

	let document: DocumentNode;
	try {
		document = parse(queryValue);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Invalid GraphQL document.';
		fail(context, itemIndex, `Query is not valid GraphQL: ${message}`);
	}

	const operations = document.definitions.filter(definition => definition.kind === 'OperationDefinition');
	if (operations.length === 0) fail(context, itemIndex, 'Query must contain a GraphQL query operation.');
	if (operations.some(operation => operation.operation === 'mutation')) {
		fail(context, itemIndex, 'GraphQL mutations are not supported; NetBox GraphQL is read-only.');
	}
	if (operations.some(operation => operation.operation === 'subscription')) {
		fail(context, itemIndex, 'GraphQL subscriptions are not supported.');
	}

	const operationNameValue = context.getNodeParameter('operationName', itemIndex, '');
	if (typeof operationNameValue !== 'string') fail(context, itemIndex, 'Operation Name must be a string.');
	const operationName = operationNameValue.trim();
	const variables = variablesObject(context, itemIndex, context.getNodeParameter('variables', itemIndex, {}));
	const timeoutValue = context.getNodeParameter('timeout', itemIndex, 30000);
	const timeout = Number(timeoutValue);
	if (!Number.isSafeInteger(timeout) || timeout <= 0) fail(context, itemIndex, 'Timeout must be a positive safe integer.');

	const response = await client.request({
		method: 'POST',
		path: '/graphql/',
		body: {
			query: queryValue,
			variables,
			...(operationName.length === 0 ? {} : { operationName }),
		},
		bodyFormat: 'json',
		responseFormat: 'json',
		timeout,
	});
	const includeMetadata = context.getNodeParameter('includeResponseMetadata', itemIndex, false) === true;
	const body = response.body ?? null;
	const json = includeMetadata
		? { body, statusCode: response.statusCode, headers: response.headers }
		: isRecord(body)
			? body as IDataObject
			: { value: body };
	return [{ json: json as IDataObject }];
}
