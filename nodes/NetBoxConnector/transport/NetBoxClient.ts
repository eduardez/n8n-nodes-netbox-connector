import FormData from 'form-data';
import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunction,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IExecuteFunctions,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { isPlainObject, isRecord } from '../utils/typeGuards';

export interface NetBoxCredentials {
	baseUrl: string;
	tokenType: 'v1' | 'v2';
	apiToken: string;
	allowUnauthorizedCerts?: boolean;
}

export interface NetBoxResponse<T = unknown> {
	statusCode: number;
	headers: Record<string, unknown>;
	body: T;
}

export type NetBoxMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type NetBoxResponseFormat = 'json' | 'text' | 'binary';
export type NetBoxBodyFormat = 'json' | 'raw' | 'formUrlEncoded' | 'multipart' | 'binary';
export type QueryStyle = 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';

export interface QuerySerialization {
	style?: QueryStyle;
	explode?: boolean;
}

export interface NetBoxRequest {
	method: NetBoxMethod;
	path: string;
	query?: Record<string, unknown>;
	querySerialization?: Record<string, QuerySerialization>;
	headers?: Record<string, string>;
	body?: unknown;
	bodyFormat?: NetBoxBodyFormat;
	responseFormat?: NetBoxResponseFormat;
	timeout?: number;
}

export interface ResolvedNextUrl {
	path: string;
	query: Record<string, unknown>;
	url: string;
}

export class NetBoxHttpError extends Error {
	constructor(
		message: string,
		readonly statusCode?: number,
		readonly responseBody?: unknown,
		readonly responseHeaders?: Record<string, unknown>,
	) {
		super(message);
		this.name = 'NetBoxHttpError';
	}
}


function statusFrom(value: unknown): number | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value.statusCode ?? value.status;
	return typeof candidate === 'number' ? candidate : undefined;
}

function nestedResponse(value: unknown): unknown {
	return isRecord(value) ? value.response : undefined;
}

function bodyFrom(value: unknown): unknown {
	return isRecord(value) ? value.body : undefined;
}
function responseDetail(body: unknown): string | undefined {
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch {
			return undefined;
		}
	}
	return isRecord(body) && typeof body.detail === 'string' ? body.detail : undefined;
}

function isPermissionDenied(body: unknown): boolean {
	return responseDetail(body)?.trim().toLowerCase() === 'you do not have permission to perform this action.';
}
function headersFrom(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const headers = value.headers;
	return isRecord(headers) ? headers : {};
}

function redactString(value: string, credentials: NetBoxCredentials): string {
	let redacted = value;
	if (credentials.apiToken) redacted = redacted.split(credentials.apiToken).join('[redacted]');
	return redacted.replace(/\b(Bearer|Token)\s+[^\s"',}]+/gi, '$1 [redacted]');
}

function redactValue(value: unknown, credentials: NetBoxCredentials): unknown {
	if (typeof value === 'string') return redactString(value, credentials);
	if (Buffer.isBuffer(value)) return redactString(value.toString('utf8'), credentials);
	if (Array.isArray(value)) return value.map(entry => redactValue(entry, credentials));
	if (!isRecord(value)) return value;
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) output[key] = redactValue(entry, credentials);
	return output;
}

function errorBodyText(value: unknown): string {
	if (value === undefined || value === null || value === '') return 'Empty response body';
	try {
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		return text === undefined ? 'Unparseable error response' : text.slice(0, 4000);
	} catch {
		return 'Unparseable error response';
	}
}

function scalarString(value: unknown, name: string): string {
	if (value === null) return 'null';
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean' || typeof value === 'number') {
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new Error(`Query parameter ${name} must not contain a non-finite number.`);
		}
		return String(value);
	}
	throw new Error(`Query parameter ${name} must contain only scalar values.`);
}

function appendArray(
	params: URLSearchParams,
	name: string,
	value: unknown[],
	serialization: QuerySerialization | undefined,
): void {
	const style = serialization?.style ?? 'form';
	const explode = serialization?.explode ?? style === 'form';
	const values = value.map(entry => scalarString(entry, name));
	if (style !== 'form' && explode) {
		throw new Error(`Array query parameter ${name} cannot use explode=true with style ${style}.`);
	}
	if (style === 'form' && explode) {
		for (const entry of values) params.append(name, entry);
		return;
	}
	if (style === 'form' || style === 'spaceDelimited' || style === 'pipeDelimited') {
		const delimiter = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
		params.append(name, values.join(delimiter));
		return;
	}
	throw new Error(`Array query parameter ${name} uses unsupported style ${style}.`);
}

function appendObject(
	params: URLSearchParams,
	name: string,
	value: Record<string, unknown>,
	serialization: QuerySerialization | undefined,
): void {
	if (serialization?.style === undefined) {
		throw new Error(`Object query parameter ${name} requires an explicit supported OpenAPI style.`);
	}
	const style = serialization.style;
	const explode = serialization.explode ?? style === 'form';
	const entries = Object.entries(value).map(([key, entry]) => [key, scalarString(entry, `${name}.${key}`)] as const);
	if (style !== 'form' && style !== 'deepObject' && explode) {
		throw new Error(`Object query parameter ${name} cannot use explode=true with style ${style}.`);
	}
	if (style === 'deepObject') {
		if (!explode) throw new Error(`Object query parameter ${name} requires explode=true for deepObject style.`);
		for (const [key, entry] of entries) params.append(`${name}[${key}]`, entry);
		return;
	}
	if (style === 'form' && explode) {
		for (const [key, entry] of entries) params.append(key, entry);
		return;
	}
	if (style === 'form' || style === 'spaceDelimited' || style === 'pipeDelimited') {
		const delimiter = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
		const flattened = entries.flatMap(([key, entry]) => [key, entry]);
		params.append(name, flattened.join(delimiter));
		return;
	}
	throw new Error(`Object query parameter ${name} uses unsupported style ${style}.`);
}

export function serializeQuery(
	query: Record<string, unknown> | undefined,
	metadata: Record<string, QuerySerialization> | undefined,
): string {
	if (query === undefined) return '';
	if (!isPlainObject(query)) throw new Error('Query parameters must be a JSON object.');
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(query)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			appendArray(params, name, value, metadata?.[name]);
		} else if (isPlainObject(value)) {
			appendObject(params, name, value, metadata?.[name]);
		} else {
			params.append(name, scalarString(value, name));
		}
	}
	return params.toString();
}

function decodePathSegment(segment: string, label: string): void {
	let decoded = segment;
	for (let iteration = 0; iteration < 12; iteration++) {
		if (decoded.includes('\\')) throw new Error(`${label} must not contain backslashes.`);
		if (decoded.split('/').some(part => part === '.' || part === '..')) throw new Error(`${label} must not contain dot traversal.`);
		if (!decoded.includes('%')) return;
		try {
			decoded = decodeURIComponent(decoded);
		} catch {
			throw new Error(`${label} contains malformed percent-encoding.`);
		}
	}
	throw new Error(`${label} contains excessive nested percent-encoding.`);
}

function validatePathSegments(path: string, label: string): void {
	if (path.includes('\\')) throw new Error(`${label} must not contain backslashes.`);
	for (const segment of path.split('/')) decodePathSegment(segment, label);
}

function rawPathFromUrl(value: string): string {
	const scheme = value.indexOf('://');
	let pathAndQuery = value;
	if (scheme >= 0) {
		const authorityStart = scheme + 3;
		const pathStart = value.slice(authorityStart).search(/[/?#]/);
		if (pathStart < 0) return '';
		const suffix = value.slice(authorityStart + pathStart);
		pathAndQuery = suffix.startsWith('/') ? suffix : '';
	} else if (value.startsWith('//')) {
		const pathStart = value.slice(2).search(/[/?#]/);
		if (pathStart < 0) return '';
		const suffix = value.slice(2 + pathStart);
		pathAndQuery = suffix.startsWith('/') ? suffix : '';
	}
	return pathAndQuery.split(/[?#]/, 1)[0];
}

function validateApiPath(path: string): void {
	if (typeof path !== 'string' || path === '') throw new Error('NetBox API path is required.');
	if (path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
		throw new Error('NetBox API paths must be relative to the configured deployment root.');
	}
	if (/[?#]/.test(path)) throw new Error('NetBox API paths must not contain a query string or fragment.');
	if (path.includes('{') || path.includes('}')) throw new Error('NetBox API path has an unresolved path parameter.');
	validatePathSegments(path, 'NetBox API path');
	if (path !== '/graphql/' && !(path.startsWith('/api/') || path === '/api/')) {
		throw new Error('NetBox requests must target /api/ paths or the fixed /graphql/ endpoint.');
	}
}

function isFormData(value: unknown): value is FormData {
	return value instanceof FormData;
}

function isBinary(value: unknown): value is Buffer | Uint8Array {
	return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function normalizeResponse(value: unknown): NetBoxResponse | undefined {
	if (!isRecord(value)) return undefined;
	const statusCode = statusFrom(value);
	if (statusCode === undefined) return undefined;
	return {
		statusCode,
		headers: headersFrom(value),
		body: value.body,
	};
}
function decodeResponseBody(response: NetBoxResponse, responseFormat: NetBoxResponseFormat): unknown {
	const successful = response.statusCode >= 200 && response.statusCode < 300;
	const contentType = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
	const parseJson = responseFormat === 'json' || (!successful && typeof contentType === 'string' && contentType.toLowerCase().includes('json'));
	if (!parseJson) return response.body;
	const text = Buffer.isBuffer(response.body)
		? response.body.toString('utf8')
		: response.body instanceof Uint8Array
			? Buffer.from(response.body).toString('utf8')
			: response.body;
	if (typeof text !== 'string' || text === '') return text;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		if (successful && responseFormat === 'json') throw new Error('NetBox returned malformed JSON.');
		return response.body;
	}
}

function isUrlEncodedBody(value: unknown): value is URLSearchParams {
	return value instanceof URLSearchParams;
}

function isJsonBody(value: unknown, request: NetBoxRequest, formData: boolean): boolean {
	return value !== undefined
		&& !formData
		&& !isBinary(value)
		&& !isUrlEncodedBody(value)
		&& request.bodyFormat !== 'raw'
		&& request.bodyFormat !== 'binary'
		&& request.bodyFormat !== 'formUrlEncoded'
		&& request.bodyFormat !== 'multipart';
}

function responseHeadersFromError(value: unknown): Record<string, unknown> {
	const direct = headersFrom(value);
	return Object.keys(direct).length > 0 ? direct : headersFrom(nestedResponse(value));
}

function makeError(
	statusCode: number | undefined,
	body: unknown,
	headers: Record<string, unknown>,
	credentials: NetBoxCredentials,
): NetBoxHttpError {
	const redactedBody = redactValue(body, credentials);
	const message = statusCode === undefined
		? 'NetBox HTTP request failed.'
		: `NetBox request failed with HTTP ${statusCode}: ${errorBodyText(redactedBody)}`;
	return new NetBoxHttpError(message, statusCode, redactedBody, headers);
}

export function normalizeBaseUrl(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') throw new Error('NetBox Base URL is required.');
	const input = value.trim();
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error('NetBox Base URL must be a valid absolute HTTP(S) URL.');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('NetBox Base URL must use HTTP or HTTPS.');
	}
	if (parsed.username !== '' || parsed.password !== '') {
		throw new Error('NetBox Base URL must not contain embedded credentials.');
	}
	if (parsed.search !== '' || parsed.hash !== '') {
		throw new Error('NetBox Base URL must not contain a query string or fragment.');
	}
	if (/\/(?:api|graphql)\/?$/i.test(parsed.pathname)) {
		throw new Error('NetBox Base URL must be the deployment root, not /api or /graphql. Remove that suffix.');
	}
	return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function authorizationHeader(credentials: NetBoxCredentials): string {
	if (credentials.tokenType !== 'v1' && credentials.tokenType !== 'v2') {
		throw new Error('NetBox Token Type must be v1 or v2.');
	}
	if (typeof credentials.apiToken !== 'string' || credentials.apiToken.trim() === '') {
		throw new Error('NetBox API Token is required.');
	}
	return `${credentials.tokenType === 'v2' ? 'Bearer' : 'Token'} ${credentials.apiToken}`;
}

export class NetBoxClient {
	readonly baseUrl: string;
	private readonly rootPath: string;
	private readonly authHeader: string;

	constructor(
		private readonly context: IExecuteFunctions,
		readonly credentials: NetBoxCredentials,
	) {
		this.baseUrl = normalizeBaseUrl(credentials.baseUrl);
		this.rootPath = new URL(this.baseUrl).pathname.replace(/\/+$/, '');
		this.authHeader = authorizationHeader(credentials);
	}

	requestUrl(request: Pick<NetBoxRequest, 'path' | 'query' | 'querySerialization'>): string {
		validateApiPath(request.path);
		const suffix = request.path === '/graphql/' ? '/graphql/' : request.path;
		const url = `${new URL(this.baseUrl).origin}${this.rootPath}${suffix}`;
		const query = serializeQuery(request.query, request.querySerialization);
		return query === '' ? url : `${url}?${query}`;
	}

	resolveNextUrl(value: unknown): ResolvedNextUrl {
		if (typeof value !== 'string' || value.trim() === '') throw new Error('NetBox pagination returned an invalid next URL.');
		const raw = value.trim();
		if (raw.includes('#') || raw.includes('\\')) throw new Error('NetBox pagination URL must not contain a fragment or backslash.');
		validatePathSegments(rawPathFromUrl(raw), 'NetBox pagination URL');
		let target: URL;
		try {
			target = new URL(raw, `${new URL(this.baseUrl).origin}${this.rootPath}/api/`);
		} catch {
			throw new Error('NetBox pagination returned an invalid next URL.');
		}
		const base = new URL(this.baseUrl);
		if (target.username !== '' || target.password !== '' || target.origin !== base.origin) {
			throw new Error('NetBox pagination URL must use the configured origin.');
		}
		if (target.hash !== '') throw new Error('NetBox pagination URL must not contain a fragment.');
		const apiPrefix = `${this.rootPath}/api/`;
		if (!target.pathname.startsWith(apiPrefix)) {
			throw new Error('NetBox pagination URL must stay under the configured /api/ root.');
		}
		const path = target.pathname.slice(this.rootPath.length);
		validateApiPath(path);
		const query: Record<string, unknown> = {};
		for (const [name, entry] of target.searchParams) {
			const current = query[name];
			if (current === undefined) query[name] = entry;
			else if (Array.isArray(current)) current.push(entry);
			else query[name] = [current, entry];
		}
		return { path, query, url: target.toString() };
	}

	async request<T = unknown>(request: NetBoxRequest): Promise<NetBoxResponse<T>> {
		const url = this.requestUrl(request);
		const responseFormat = request.responseFormat ?? 'json';
		const timeout = request.timeout ?? 30000;
		if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('NetBox request timeout must be a positive integer in milliseconds.');
		const body = request.body;
		const formData = isFormData(body);
		if (request.bodyFormat === 'multipart' && !formData) throw new Error('Multipart requests require a FormData body.');
		if (request.bodyFormat === 'binary' && !isBinary(body)) throw new Error('Binary requests require a Buffer or Uint8Array body.');
		if (request.bodyFormat === 'raw' && typeof body !== 'string' && !isBinary(body)) {
			throw new Error('Raw requests require a string or binary body.');
		}
		if (request.bodyFormat === 'formUrlEncoded' && !isUrlEncodedBody(body) && typeof body !== 'string') {
			throw new Error('URL-encoded requests require URLSearchParams or a string body.');
		}
		const jsonBody = isJsonBody(body, request, formData);
		const headers: Record<string, string> = {};
		const multipartHeaders = isFormData(body) ? body.getHeaders() : {};
		for (const [name, value] of Object.entries(multipartHeaders)) headers[name.toLowerCase()] = value;
		for (const [name, value] of Object.entries(request.headers ?? {})) {
			const key = name.toLowerCase();
			if (key === 'authorization' || key === 'host' || key === 'cookie' || (formData && key === 'content-type')) continue;
			if (typeof value !== 'string') throw new Error(`HTTP header ${name} must be a string.`);
			headers[key] = value;
		}
		headers.authorization = this.authHeader;
		if (request.bodyFormat === 'formUrlEncoded' && headers['content-type'] === undefined) {
			headers['content-type'] = 'application/x-www-form-urlencoded';
		}
		if (jsonBody && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
		let wireBody = isUrlEncodedBody(body) ? body.toString() : body;
		if (jsonBody && responseFormat !== 'json') {
			try {
				wireBody = JSON.stringify(body);
			} catch {
				throw new Error('NetBox JSON request body could not be serialized.');
			}
		}
		const parseJson = responseFormat === 'json' && !(
			body !== undefined && !jsonBody
		);
		const options: IHttpRequestOptions = {
			method: request.method as IHttpRequestOptions['method'],
			url,
			headers,
			json: parseJson,
			encoding: responseFormat === 'binary' ? 'arraybuffer' : responseFormat === 'text' || !parseJson ? 'text' : 'json',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			skipSslCertificateValidation: Boolean(this.credentials.allowUnauthorizedCerts),
			disableFollowRedirect: true,
			timeout,
		};
		if (body !== undefined) options.body = wireBody as IHttpRequestOptions['body'];
		try {
			const raw = await this.context.helpers.httpRequest(options);
			const response = normalizeResponse(raw);
			if (response === undefined) throw makeError(undefined, undefined, {}, this.credentials);
			const decoded = { ...response, body: decodeResponseBody(response, responseFormat) };
			if (decoded.statusCode < 200 || decoded.statusCode >= 300) {
				throw makeError(decoded.statusCode, decoded.body, decoded.headers, this.credentials);
			}
			return decoded as NetBoxResponse<T>;
		} catch (caught) {
			if (caught instanceof NetBoxHttpError) throw caught;
			const nested = nestedResponse(caught);
			const status = statusFrom(caught) ?? statusFrom(nested);
			const responseBody = bodyFrom(caught) ?? bodyFrom(nested);
			throw makeError(status, responseBody, responseHeadersFromError(caught), this.credentials);
		}
	}
}

export const netBoxApiTest: ICredentialTestFunction = async function (
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
) {
	if (credential.data === undefined) return { status: 'Error', message: 'NetBox credentials are missing.' };
	const data = credential.data as unknown as NetBoxCredentials;
	try {
		const baseUrl = normalizeBaseUrl(data.baseUrl);
		const authorization = authorizationHeader(data);
		const requestOptions = {
			method: 'GET' as const,
			headers: { Authorization: authorization },
			json: false,
			resolveWithFullResponse: true,
			simple: false,
			followRedirect: false,
			rejectUnauthorized: !data.allowUnauthorizedCerts,
			timeout: 30000,
		};
		let response = await this.helpers.request(`${baseUrl}/api/authentication-check/`, requestOptions);
		let status = statusFrom(response);
		if (status === 404) {
			response = await this.helpers.request(`${baseUrl}/api/users/users/?limit=1`, requestOptions);
			status = statusFrom(response);
			if (status === 403 && isPermissionDenied(bodyFrom(response))) {
				return { status: 'OK', message: 'NetBox authentication succeeded; the token cannot list users.' };
			}
		}
		if (status === 200) return { status: 'OK', message: 'NetBox authentication successful.' };
		return { status: 'Error', message: `NetBox authentication failed${status === undefined ? '' : ` with HTTP ${status}`}.` };
	} catch (caught) {
		const status = statusFrom(caught) ?? statusFrom(nestedResponse(caught));
		const message = caught instanceof Error && /NetBox Base URL|NetBox Token Type|NetBox API Token/.test(caught.message)
			? caught.message
			: `NetBox authentication request failed${status === undefined ? '' : ` with HTTP ${status}`}.`;
		return { status: 'Error', message };
	}
};
