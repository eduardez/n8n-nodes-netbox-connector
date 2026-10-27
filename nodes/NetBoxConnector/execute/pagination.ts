import type { NetBoxClient, QuerySerialization } from '../transport/NetBoxClient';
import { isRecord } from '../utils/typeGuards';

export interface PaginationOptions {
	returnAll?: boolean;
	limit?: number;
	pageSize?: number;
	headers?: Record<string, string>;
	timeout?: number;
	querySerialization?: Record<string, QuerySerialization>;
}


function positiveInteger(value: number | undefined, fallback: number, label: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer.`);
	return result;
}

function isPaginationEnvelope(value: unknown): value is { results: unknown[]; next: string | null } {
	return isRecord(value) && Array.isArray(value.results) && (typeof value.next === 'string' || value.next === null);
}

function canonicalUrl(value: string): string {
	const url = new URL(value);
	url.searchParams.sort();
	return url.toString();
}

function mergeQuery(
	initial: Record<string, unknown>,
	next: Record<string, unknown>,
	pageSize: number,
): Record<string, unknown> {
	return { ...initial, ...next, limit: pageSize };
}

export async function fetchPaginatedList(
	client: NetBoxClient,
	path: string,
	query: Record<string, unknown>,
	options: PaginationOptions = {},
): Promise<unknown[]> {
	if (!isRecord(query)) throw new Error('Pagination filters must be a JSON object.');
	if (Object.prototype.hasOwnProperty.call(query, 'limit')) {
		throw new Error('Do not set queryParameters.limit when automatic pagination is enabled; use Page Size instead.');
	}
	if (Object.prototype.hasOwnProperty.call(query, 'start') && Object.prototype.hasOwnProperty.call(query, 'offset')) {
		throw new Error('Use either the start cursor or offset, not both.');
	}
	const returnAll = options.returnAll ?? false;
	const limit = positiveInteger(options.limit, 50, 'Limit');
	const pageSize = positiveInteger(options.pageSize, 100, 'Page Size');
	const initialQuery = { ...query };
	const firstQuery = { ...initialQuery, limit: pageSize };
	let requestPath = path;
	let requestQuery: Record<string, unknown> = firstQuery;
	const seen = new Set<string>();
	seen.add(canonicalUrl(client.requestUrl({ path: requestPath, query: requestQuery, querySerialization: options.querySerialization })));
	const output: unknown[] = [];

	while (true) {
		const response = await client.request({
			method: 'GET',
			path: requestPath,
			query: requestQuery,
			querySerialization: options.querySerialization,
			headers: options.headers,
			timeout: options.timeout,
			responseFormat: 'json',
		});
		if (!isPaginationEnvelope(response.body)) {
			throw new Error('This operation did not return a paginated {results,next} response.');
		}
		const remaining = returnAll ? response.body.results.length : Math.max(0, limit - output.length);
		output.push(...response.body.results.slice(0, remaining));
		if (!returnAll && output.length >= limit) return output;
		if (response.body.next === null) return output;
		const next = client.resolveNextUrl(response.body.next);
		const requestQueryForNext = mergeQuery(initialQuery, next.query, pageSize);
		const identity = canonicalUrl(client.requestUrl({
			path: next.path,
			query: requestQueryForNext,
			querySerialization: options.querySerialization,
		}));
		if (seen.has(identity)) throw new Error('NetBox pagination repeated a next URL without making progress.');
		seen.add(identity);
		requestPath = next.path;
		requestQuery = requestQueryForNext;
	}
}

export function isPaginatedResponse(value: unknown): value is { results: unknown[]; next: string | null } {
	return isPaginationEnvelope(value);
}
