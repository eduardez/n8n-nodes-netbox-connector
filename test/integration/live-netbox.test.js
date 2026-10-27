'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const test = require('node:test');

const { NetBoxConnector } = require('../../dist/nodes/NetBoxConnector/NetBoxConnector.node.js');
const { OPERATIONS } = require('../../dist/nodes/NetBoxConnector/catalog/operations.generated.js');

if (process.env.NETBOX_INTEGRATION_DISPOSABLE !== '1') {
	throw new Error('Refusing live tests without NETBOX_INTEGRATION_DISPOSABLE=1 for a disposable NetBox instance');
}

for (const name of ['NETBOX_BASE_URL', 'NETBOX_API_TOKEN', 'NETBOX_TEST_PREFIX_ID']) {
	if (!process.env[name]) throw new Error(`Live NetBox tests require ${name}`);
}

const credentials = {
	baseUrl: process.env.NETBOX_BASE_URL,
	tokenType: process.env.NETBOX_TOKEN_TYPE ?? 'v2',
	apiToken: process.env.NETBOX_API_TOKEN,
};
const prefixId = Number(process.env.NETBOX_TEST_PREFIX_ID);
if (!Number.isSafeInteger(prefixId) || prefixId <= 0) {
	throw new Error('NETBOX_TEST_PREFIX_ID must be a positive safe integer on the disposable NetBox instance');
}
const writesEnabled = process.env.NETBOX_INTEGRATION_ALLOW_WRITES === '1';

async function httpRequest(options) {
	let body = options.body;
	if (options.json && body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
		body = JSON.stringify(body);
	}
	const response = await fetch(options.url, {
		method: options.method,
		headers: options.headers,
		...(body === undefined ? {} : { body }),
		redirect: 'manual',
		signal: AbortSignal.timeout(options.timeout),
	});
	let responseBody;
	if (options.encoding === 'arraybuffer') {
		responseBody = Buffer.from(await response.arrayBuffer());
	} else {
		const text = await response.text();
		responseBody = options.json && text !== '' ? JSON.parse(text) : text;
	}
	return {
		statusCode: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		body: responseBody,
	};
}

async function execute(parameters) {
	const context = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => credentials,
		getNodeParameter(name, _itemIndex, defaultValue) {
			return Object.hasOwn(parameters, name) ? parameters[name] : defaultValue;
		},
		getNode: () => ({ name: 'NetBox Connector Integration', type: 'n8n-nodes-netbox-connector.netBoxConnector' }),
		continueOnFail: () => false,
		helpers: {
			httpRequest,
			async getBinaryDataBuffer() {
				throw new Error('Live scenarios do not require input binaries');
			},
			async prepareBinaryData(buffer, fileName, mimeType) {
				return { data: buffer.toString('base64'), fileName, mimeType };
			},
		},
	};
	return new NetBoxConnector().execute.call(context);
}

function baseParameters(resource, operation) {
	return {
		resource,
		operation,
		queryParameters: {},
		headers: {},
		options: {},
		includeResponseMetadata: false,
		timeout: 30000,
	};
}

test('native REST follows pagination without exceeding the configured result limit', async () => {
	const result = await execute({
		...baseParameters('dcim/devices', 'dcim_devices_list'),
		limit: 2,
		pageSize: 1,
		returnAll: false,
	});
	assert.ok(Array.isArray(result[0]));
	assert.ok(result[0].length <= 2);
});

test('Custom REST returns raw response metadata for a device list', async () => {
	const result = await execute({
		...baseParameters('customApi', 'request'),
		method: 'GET',
		path: '/api/dcim/devices/',
		queryParameters: { limit: 1 },
		bodyType: 'none',
		responseFormat: 'json',
		includeResponseMetadata: true,
	});
	assert.equal(result[0].length, 1);
	assert.equal(result[0][0].json.statusCode, 200);
	assert.ok(Array.isArray(result[0][0].json.body.results));
});

test('read-only GraphQL query reaches the fixed endpoint and returns data', async () => {
	const result = await execute({
		...baseParameters('graphql', 'query'),
		query: 'query NetBoxConnectorIntegration { __typename }',
		operationName: 'NetBoxConnectorIntegration',
		variables: {},
	});
	assert.equal(typeof result[0][0].json.data.__typename, 'string');
});

test('IPAM read helpers query available IPs and prefixes', async () => {
	const availableIps = await execute({
		...baseParameters('helpers', 'availableIps'),
		parentType: 'prefix',
		parentId: prefixId,
	});
	const availablePrefixes = await execute({
		...baseParameters('helpers', 'availablePrefixes'),
		prefixId,
	});
	assert.ok(Array.isArray(availableIps[0]));
	assert.ok(Array.isArray(availablePrefixes[0]));
});

test('a temporary tag can be created and deleted on the disposable instance', { skip: !writesEnabled }, async () => {
	const create = OPERATIONS.find(operation => operation.method === 'POST' && operation.path === '/api/extras/tags/');
	const remove = OPERATIONS.find(operation => operation.method === 'DELETE' && operation.path === '/api/extras/tags/{id}/');
	assert.ok(create);
	assert.ok(remove);
	const slug = `netbox-connector-it-${randomBytes(6).toString('hex')}`;
	let tagId;
	try {
		const result = await execute({
			...baseParameters('extras/tags', create.id),
			bodyFormat: 'json',
			body: { name: slug, slug },
		});
		tagId = Number(result[0][0]?.json.id);
		assert.ok(Number.isSafeInteger(tagId) && tagId > 0);
	} finally {
		if (tagId !== undefined) {
			await execute({
				...baseParameters('extras/tags', remove.id),
				[`path_${remove.id}_id`]: tagId,
			});
		}
	}
});
