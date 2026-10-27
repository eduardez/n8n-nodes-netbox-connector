'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const FormData = require('form-data');

const {
	NetBoxClient,
	NetBoxHttpError,
	netBoxApiTest,
	normalizeBaseUrl,
	serializeQuery,
} = require('../dist/nodes/NetBoxConnector/transport/NetBoxClient.js');
const { fetchPaginatedList } = require('../dist/nodes/NetBoxConnector/execute/pagination.js');

const credentials = {
	baseUrl: 'https://netbox.example.test/netbox/',
	tokenType: 'v2',
	apiToken: 'nbt_test.secret',
	allowUnauthorizedCerts: false,
};

function createContext(responses = []) {
	const requests = [];
	const queue = [...responses];
	return {
		requests,
		helpers: {
			async httpRequest(options) {
				requests.push(options);
				if (queue.length === 0) throw new Error(`Unexpected request ${options.method} ${options.url}`);
				const response = queue.shift();
				return typeof response === 'function' ? response(options) : response;
			},
		},
	};
}

function response(body, statusCode = 200, headers = {}) {
	return { body, statusCode, headers };
}

test('base URL rejects API suffixes and preserves reverse-proxy roots', () => {
	assert.equal(normalizeBaseUrl('https://netbox.example.test/netbox/'), 'https://netbox.example.test/netbox');
	assert.throws(() => normalizeBaseUrl('https://netbox.example.test/netbox/api/'), /deployment root/);
	assert.throws(() => normalizeBaseUrl('https://user:pass@netbox.example.test'), /embedded credentials/);
	assert.throws(() => normalizeBaseUrl('https://netbox.example.test/?site=one'), /query string/);
});

test('query serialization retains false, zero, empty and null and repeats array keys', () => {
	const encoded = serializeQuery({
		tag: ['edge', 'core'],
		enabled: false,
		limit: 0,
		name: '',
		owner: null,
	}, { tag: { style: 'form', explode: true } });
	const params = new URLSearchParams(encoded);
	assert.deepEqual(params.getAll('tag'), ['edge', 'core']);
	assert.equal(params.get('enabled'), 'false');
	assert.equal(params.get('limit'), '0');
	assert.equal(params.get('name'), '');
	assert.equal(params.get('owner'), 'null');
	assert.throws(() => serializeQuery({ custom: { nested: 'value' } }), /explicit supported OpenAPI style/);
	assert.throws(() => serializeQuery({ tags: ['a'] }, { tags: { style: 'spaceDelimited', explode: true } }), /explode=true/);
});

test('request sends authenticated full responses and prevents protected header overrides', async () => {
	const context = createContext([response({ id: 4 })]);
	const client = new NetBoxClient(context, credentials);
	const result = await client.request({
		method: 'GET',
		path: '/api/dcim/devices/',
		query: { tag: ['edge', 'core'], enabled: false },
		querySerialization: { tag: { style: 'form', explode: true } },
		headers: { AUTHORIZATION: 'Bearer attacker', Host: 'attacker.test', COOKIE: 'session=attacker', Accept: 'application/json' },
	});
	assert.deepEqual(result, response({ id: 4 }));
	assert.equal(context.requests.length, 1);
	const sent = context.requests[0];
	assert.equal(sent.headers.authorization, `Bearer ${credentials.apiToken}`);
	assert.equal(Object.hasOwn(sent.headers, 'host'), false);
	assert.equal(Object.hasOwn(sent.headers, 'cookie'), false);
	assert.equal(sent.headers.accept, 'application/json');
	assert.deepEqual(new URL(sent.url).searchParams.getAll('tag'), ['edge', 'core']);
	assert.equal(sent.timeout, 30000);
	assert.equal(sent.returnFullResponse, true);
	assert.equal(sent.disableFollowRedirect, true);
});

test('URL-encoded requests send an encoded body with the form media type', async () => {
	const context = createContext([response({ created: true })]);
	const client = new NetBoxClient(context, credentials);
	await client.request({
		method: 'POST',
		path: '/api/extras/tags/',
		body: new URLSearchParams([['name', 'edge & core'], ['slug', 'edge']]),
		bodyFormat: 'formUrlEncoded',
	});
	assert.equal(context.requests[0].body, 'name=edge+%26+core&slug=edge');
	assert.equal(context.requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
});

test('multipart requests retain the generated boundary despite a custom content-type', async () => {
	const context = createContext([response({ created: true })]);
	const client = new NetBoxClient(context, credentials);
	const form = new FormData();
	form.append('image', Buffer.from('sample'), { filename: 'sample.png' });
	await client.request({
		method: 'POST',
		path: '/api/extras/image-attachments/',
		body: form,
		bodyFormat: 'multipart',
		headers: { 'content-type': 'application/json' },
	});
	assert.match(context.requests[0].headers['content-type'], /^multipart\/form-data; boundary=/);
});

test('HTTP errors retain structured details while redacting the token', async () => {
	const context = createContext([response({ detail: `Rejected ${credentials.apiToken}`, errors: [{ field: 'name' }] }, 400)]);
	const client = new NetBoxClient(context, credentials);
	await assert.rejects(client.request({ method: 'POST', path: '/api/dcim/devices/', body: { name: 'bad' } }), error => {
		assert.ok(error instanceof NetBoxHttpError);
		assert.equal(error.statusCode, 400);
		assert.deepEqual(error.responseBody, { detail: 'Rejected [redacted]', errors: [{ field: 'name' }] });
		assert.doesNotMatch(error.message, /nbt_test\.secret/);
		return true;
	});
});

test('pagination follows a validated cursor and retains initial filters when count is null', async () => {
	const first = {
		count: null,
		next: 'https://netbox.example.test/netbox/api/dcim/devices/?name=router&tag=edge&tag=core&enabled=false&limit=1&offset=1',
		previous: null,
		results: [{ id: 1 }],
	};
	const second = { count: null, next: null, previous: null, results: [{ id: 2 }] };
	const context = createContext([response(first), response(second)]);
	const client = new NetBoxClient(context, credentials);
	const results = await fetchPaginatedList(client, '/api/dcim/devices/', {
		name: 'router',
		tag: ['edge', 'core'],
		enabled: false,
	}, {
		returnAll: true,
		pageSize: 1,
		querySerialization: { tag: { style: 'form', explode: true } },
	});
	assert.deepEqual(results, [{ id: 1 }, { id: 2 }]);
	assert.equal(context.requests.length, 2);
	const nextQuery = new URL(context.requests[1].url).searchParams;
	assert.equal(nextQuery.get('name'), 'router');
	assert.deepEqual(nextQuery.getAll('tag'), ['edge', 'core']);
	assert.equal(nextQuery.get('enabled'), 'false');
	assert.equal(nextQuery.get('limit'), '1');
});

test('limited pagination emits exactly the limit even when a server page is larger', async () => {
	const context = createContext([response({ count: 8, next: 'https://netbox.example.test/netbox/api/dcim/devices/?offset=5', results: [{ id: 1 }, { id: 2 }, { id: 3 }] })]);
	const client = new NetBoxClient(context, credentials);
	const results = await fetchPaginatedList(client, '/api/dcim/devices/', {}, { limit: 2, pageSize: 3 });
	assert.deepEqual(results, [{ id: 1 }, { id: 2 }]);
	assert.equal(context.requests.length, 1);
});

test('pagination rejects ambiguous cursors, query limit overrides and hostile or repeated next URLs', async () => {
	const empty = createContext();
	const client = new NetBoxClient(empty, credentials);
	await assert.rejects(fetchPaginatedList(client, '/api/dcim/devices/', { limit: 1 }), /use Page Size/);
	await assert.rejects(fetchPaginatedList(client, '/api/dcim/devices/', { start: 'cursor', offset: 0 }), /either the start cursor or offset/);
	assert.equal(empty.requests.length, 0);
	assert.throws(() => client.resolveNextUrl('https://other.example.test/netbox/api/dcim/devices/'), /configured origin/);
	assert.throws(() => client.resolveNextUrl('https://netbox.example.test/netbox/api/%252e%252e/users/'), /dot traversal/);
	const repeated = createContext([response({ count: null, next: 'https://netbox.example.test/netbox/api/dcim/devices/?limit=100', results: [] })]);
	await assert.rejects(fetchPaginatedList(new NetBoxClient(repeated, credentials), '/api/dcim/devices/', {}, { returnAll: true }), /repeated a next URL/);
	assert.equal(repeated.requests.length, 1);
	const unchanged = createContext([response({
		count: null,
		next: 'https://netbox.example.test/netbox/api/dcim/devices/',
		results: [],
	})]);
	await assert.rejects(
		fetchPaginatedList(new NetBoxClient(unchanged, credentials), '/api/dcim/devices/', { name: 'router' }, { returnAll: true }),
		/repeated a next URL/,
	);
	assert.equal(unchanged.requests.length, 1);
});

test('credential test authenticates against the protected check endpoint for v1 and v2', async () => {
	for (const tokenType of ['v1', 'v2']) {
		let call;
		const result = await netBoxApiTest.call({
			helpers: {
				request: async (url, options) => {
					call = { url, options };
					return response({ user: 'automation' }, 200);
				},
			},
		}, { data: { ...credentials, tokenType } });
		assert.equal(result.status, 'OK');
		assert.equal(call.url, 'https://netbox.example.test/netbox/api/authentication-check/');
		assert.equal(call.options.headers.Authorization, `${tokenType === 'v2' ? 'Bearer' : 'Token'} ${credentials.apiToken}`);
		assert.equal(call.options.followRedirect, false);
	}
});
