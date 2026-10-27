'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { NodeOperationError } = require('n8n-workflow');

const { NetBoxClient } = require('../dist/nodes/NetBoxConnector/transport/NetBoxClient.js');
const { executeCatalogOperation } = require('../dist/nodes/NetBoxConnector/execute/executeCatalogOperation.js');
const { executeCustomOperation } = require('../dist/nodes/NetBoxConnector/execute/executeCustomOperation.js');
const { executeGraphql } = require('../dist/nodes/NetBoxConnector/execute/executeGraphql.js');
const { executeNetBoxHelper } = require('../dist/nodes/NetBoxConnector/helpers/netboxHelpers.js');
const { OPERATIONS } = require('../dist/nodes/NetBoxConnector/catalog/operations.generated.js');
const { NetBoxConnector } = require('../dist/nodes/NetBoxConnector/NetBoxConnector.node.js');

const credentials = {
	baseUrl: 'https://netbox.example.test',
	tokenType: 'v2',
	apiToken: 'nbt_test.secret',
};

function createExecutionContext(parameters) {
	const requests = [];
	const context = {
		getNodeParameter(name, _itemIndex, defaultValue) {
			return Object.hasOwn(parameters, name) ? parameters[name] : defaultValue;
		},
		getNode() {
			return { name: 'NetBox Connector', type: 'n8n-nodes-netbox-connector.netBoxConnector' };
		},
		helpers: {
			async httpRequest(options) {
				requests.push(options);
				return { body: {}, statusCode: 200, headers: { 'content-type': 'application/json' } };
			},
			async getBinaryDataBuffer() {
				return Buffer.from('file');
			},
			async prepareBinaryData(buffer, fileName, mimeType) {
				return { data: buffer.toString('base64'), fileName, mimeType };
			},
		},
	};
	return { context, client: new NetBoxClient(context, credentials), requests };
}

test('read-only GraphQL rejects a document containing a mutation before making a request', async () => {
	const { context, client, requests } = createExecutionContext({
		query: 'query Read { devices { id } } mutation Write { createDevice { id } }',
		operationName: 'Read',
		variables: {},
	});
	await assert.rejects(executeGraphql(context, client, 0), error =>
		error instanceof NodeOperationError && /mutations are not supported/.test(error.message));
	assert.equal(requests.length, 0);
});

test('Custom REST rejects encoded dot traversal before making a request', async () => {
	const { context, client, requests } = createExecutionContext({
		method: 'GET',
		path: '/api/%2e%2e/users/',
		queryParameters: {},
		headers: {},
		bodyType: 'none',
		responseFormat: 'json',
	});
	await assert.rejects(
		executeCustomOperation(context, client, 0, { json: {}, binary: {} }),
		error => error instanceof NodeOperationError && /dot traversal/.test(error.message),
	);
	assert.equal(requests.length, 0);
});

test('Native multipart create requires the schema-declared image binary mapping', async () => {
	const operation = OPERATIONS.find(entry => entry.id === 'extras_image_attachments_create');
	assert.ok(operation);
	const { context, client, requests } = createExecutionContext({
		queryParameters: {},
		headers: {},
		options: {},
		includeResponseMetadata: false,
		returnAll: false,
		timeout: 30000,
		bodyFormat: 'multipart',
		body: {},
		binaryFields: {},
	});
	await assert.rejects(
		executeCatalogOperation(context, client, 0, { json: {}, binary: {} }, operation),
		error => error instanceof NodeOperationError && /Required binary field "image"/.test(error.message),
	);
	assert.equal(requests.length, 0);
});

test('Prefix allocation requires prefix_length before making a request', async () => {
	const { context, client, requests } = createExecutionContext({
		prefixId: 8,
		requestBody: [{}],
		timeout: 30000,
		includeResponseMetadata: false,
	});
	await assert.rejects(
		executeNetBoxHelper(context, client, 0, 'allocatePrefix'),
		error => error instanceof NodeOperationError && /prefix_length/.test(error.message),
	);
	assert.equal(requests.length, 0);
});

test('IP allocation sends the schema array shape and returns allocated addresses', async () => {
	const { context, client, requests } = createExecutionContext({
		parentType: 'prefix',
		parentId: 12,
		requestBody: [{ prefix_length: 32 }],
		timeout: 30000,
		includeResponseMetadata: false,
	});
	context.helpers.httpRequest = async options => {
		requests.push(options);
		return {
			body: [{ id: 101, address: '192.0.2.10/32' }],
			statusCode: 201,
			headers: { 'content-type': 'application/json' },
		};
	};
	const result = await executeNetBoxHelper(context, client, 0, 'allocateIp');
	assert.deepEqual(result, [{ json: { id: 101, address: '192.0.2.10/32' } }]);
	assert.equal(requests[0].method, 'POST');
	assert.equal(new URL(requests[0].url).pathname, '/api/ipam/prefixes/12/available-ips/');
	assert.deepEqual(requests[0].body, [{ prefix_length: 32 }]);
});

test('the node executes a filtered paginated device read and pairs its result', async () => {
	const requests = [];
	const parameters = {
		resource: 'dcim/devices',
		operation: 'dcim_devices_list',
		queryParameters: { name: 'switch-01' },
		headers: {},
		options: {},
		includeResponseMetadata: false,
		returnAll: false,
		limit: 10,
		pageSize: 2,
		timeout: 30000,
	};
	const base = createExecutionContext(parameters).context;
	const context = {
		...base,
		getInputData: () => [{ json: {} }],
		getCredentials: async () => credentials,
		continueOnFail: () => false,
		helpers: {
			async httpRequest(options) {
				requests.push(options);
				return {
					body: { count: 1, next: null, previous: null, results: [{ id: 42, name: 'switch-01' }] },
					statusCode: 200,
					headers: { 'content-type': 'application/json' },
				};
			},
		},
	};
	const result = await new NetBoxConnector().execute.call(context);
	assert.deepEqual(result, [[{ json: { id: 42, name: 'switch-01' }, pairedItem: { item: 0 } }]]);
	assert.equal(requests.length, 1);
	assert.equal(new URL(requests[0].url).searchParams.get('name'), 'switch-01');
});
