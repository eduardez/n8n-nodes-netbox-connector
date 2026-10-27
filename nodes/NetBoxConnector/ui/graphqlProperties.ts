import type { INodeProperties } from 'n8n-workflow';

const graphqlOperation = { show: { resource: ['graphql'] } };
const graphqlQuery = { show: { resource: ['graphql'], operation: ['query'] } };

export function buildGraphqlProperties(): INodeProperties[] {
	return [
		{
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			options: [{ name: 'Query', value: 'query' }],
			default: 'query',
			displayOptions: graphqlOperation,
		},
		{
			displayName: 'Query',
			name: 'query',
			type: 'string',
			typeOptions: { rows: 6 },
			required: true,
			default: '',
			displayOptions: graphqlQuery,
			description: 'Read-only GraphQL query document',
		},
		{
			displayName: 'Operation Name',
			name: 'operationName',
			type: 'string',
			default: '',
			displayOptions: graphqlQuery,
			description: 'Selects one operation when the document contains multiple query operations',
		},
		{
			displayName: 'Variables',
			name: 'variables',
			type: 'json',
			default: '{}',
			displayOptions: graphqlQuery,
			description: 'GraphQL variables as a JSON object',
		},
		{
			displayName: 'Include Response Metadata',
			name: 'includeResponseMetadata',
			type: 'boolean',
			default: false,
			displayOptions: graphqlQuery,
			description: 'Whether to include the raw GraphQL response body, HTTP status, and headers',
		},
		{
			displayName: 'Timeout',
			name: 'timeout',
			type: 'number',
			default: 30000,
			typeOptions: { minValue: 1 },
			displayOptions: graphqlQuery,
			description: 'Request timeout in milliseconds',
		},
	];
}
