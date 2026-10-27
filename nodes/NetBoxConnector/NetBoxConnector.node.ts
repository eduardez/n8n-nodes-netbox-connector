import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { OPERATIONS } from './catalog/operations.generated';
import { executeCatalogOperation } from './execute/executeCatalogOperation';
import { executeCustomOperation } from './execute/executeCustomOperation';
import { executeGraphql } from './execute/executeGraphql';
import { executeNetBoxHelper } from './helpers/netboxHelpers';
import { NetBoxClient, NetBoxHttpError, netBoxApiTest, type NetBoxCredentials } from './transport/NetBoxClient';
import { buildProperties } from './ui/buildProperties';

const CUSTOM_API_RESOURCE = 'customApi';
const GRAPHQL_RESOURCE = 'graphql';
const HELPERS_RESOURCE = 'helpers';
const OPERATIONS_BY_ID = new Map(OPERATIONS.map(operation => [operation.id, operation]));

function errorOutput(error: Error, itemIndex: number): INodeExecutionData {
	if (error instanceof NetBoxHttpError) {
		return {
			json: {
				error: error.message,
				...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
				...(error.responseBody === undefined ? {} : { details: error.responseBody as IDataObject }),
			},
			pairedItem: { item: itemIndex },
		};
	}
	return { json: { error: error.message }, pairedItem: { item: itemIndex } };
}

export class NetBoxConnector implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'NetBox Connector',
		name: 'netBoxConnector',
		icon: 'file:netbox-logo.svg',
		group: ['transform'],
		version: 1,
		description: 'Access NetBox REST and read-only GraphQL APIs with catalog operations and provisioning helpers.',
		defaults: { name: 'NetBox Connector' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'netBoxApi', required: true, testedBy: 'netBoxApiTest' }],
		properties: buildProperties(),
	};

	methods = {
		credentialTest: {
			netBoxApiTest,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const inputItems = this.getInputData();
		const credentials = (await this.getCredentials('netBoxApi')) as unknown as NetBoxCredentials;
		const client = new NetBoxClient(this, credentials);
		const outputItems: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < inputItems.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operationId = this.getNodeParameter('operation', itemIndex) as string;
				let results: INodeExecutionData[];
				if (resource === CUSTOM_API_RESOURCE && operationId === 'request') {
					results = await executeCustomOperation(this, client, itemIndex, inputItems[itemIndex]);
				} else if (resource === GRAPHQL_RESOURCE && operationId === 'query') {
					results = await executeGraphql(this, client, itemIndex);
				} else if (resource === HELPERS_RESOURCE) {
					results = await executeNetBoxHelper(this, client, itemIndex, operationId);
				} else {
					const operation = OPERATIONS_BY_ID.get(operationId);
					if (operation === undefined || operation.resource !== resource) {
						throw new NodeOperationError(this.getNode(), `Operation ${operationId} is not available for resource ${resource}.`);
					}
					results = await executeCatalogOperation(this, client, itemIndex, inputItems[itemIndex], operation);
				}
				for (const result of results) {
					outputItems.push({
						...result,
						pairedItem: { item: itemIndex },
					});
				}
			} catch (caught) {
				const error = caught instanceof Error ? caught : new Error(String(caught));
				if (this.continueOnFail()) {
					outputItems.push(errorOutput(error, itemIndex));
					continue;
				}
				if (error instanceof NetBoxHttpError) {
					throw new NodeApiError(this.getNode(), {
						message: error.message,
						...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
						...(error.responseBody === undefined ? {} : { responseBody: JSON.stringify(error.responseBody) ?? String(error.responseBody) }),
					}, {
						message: error.message,
						...(error.statusCode === undefined ? {} : { httpCode: String(error.statusCode) }),
						itemIndex,
					});
				}
				if (error instanceof NodeApiError) throw error;
				throw new NodeOperationError(this.getNode(), error.message, { itemIndex });
			}
		}
		return [outputItems];
	}
}
