#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = path.join(ROOT, 'scripts/schema/netbox-4.7.3.openapi.json');
const MANIFEST_PATH = path.join(ROOT, 'scripts/schema/manifest.json');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const PATH_ITEM_KEYS = new Set(['$ref', 'summary', 'description', 'servers', 'parameters']);

function fail(message) {
  throw new Error(message);
}

async function loadInput() {
  const args = process.argv.slice(2);
  let input = DEFAULT_INPUT;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--input' || !args[1]) {
      fail('Usage: node scripts/generate-catalog.mjs [--input <path-or-url>]');
    }
    input = args[1];
  }
  if (/^https?:\/\//i.test(input)) {
    const headers = {};
    const token = process.env.NETBOX_TOKEN;
    if (token) {
      const tokenType = process.env.NETBOX_TOKEN_TYPE || 'v2';
      if (!['v1', 'v2'].includes(tokenType)) fail('NETBOX_TOKEN_TYPE must be v1 or v2');
      headers.Authorization = `${tokenType === 'v2' ? 'Bearer' : 'Token'} ${token}`;
    }
    const response = await fetch(input, { headers, redirect: 'error' });
    if (!response.ok) fail(`Schema download failed: HTTP ${response.status}`);
    return { schema: await response.json(), source: input };
  }
  const inputPath = path.resolve(input);
  return { schema: JSON.parse(await readFile(inputPath, 'utf8')), source: inputPath };
}

function resolveLocalRef(ref, root) {
  if (!ref.startsWith('#/')) fail(`Unsupported non-local schema reference: ${ref}`);
  let current = root;
  for (const encoded of ref.slice(2).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      fail(`Unresolved schema reference: ${ref}`);
    }
    current = current[key];
  }
  return current;
}

function resolveTree(value, root, activeRefs = new Set()) {
  if (Array.isArray(value)) return value.map((child) => resolveTree(child, root, activeRefs));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string') {
    const ref = value.$ref;
    const base = { ...value };
    delete base.$ref;
    if (activeRefs.has(ref)) return Object.keys(base).length ? base : { $ref: ref };
    const nextRefs = new Set(activeRefs);
    nextRefs.add(ref);
    const target = resolveLocalRef(ref, root);
    const resolvedTarget = resolveTree(target, root, nextRefs);
    const resolvedSiblings = resolveTree(base, root, activeRefs);
    if (resolvedTarget && typeof resolvedTarget === 'object' && !Array.isArray(resolvedTarget)) {
      return { ...resolvedTarget, ...resolvedSiblings };
    }
    return Object.keys(resolvedSiblings).length ? resolvedSiblings : resolvedTarget;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) result[key] = resolveTree(child, root, activeRefs);
  return result;
}

function kindOf(schema) {
  if (Array.isArray(schema?.type)) {
    const types = schema.type.filter((type) => type !== 'null');
    return types.length === 1 ? kindOf({ ...schema, type: types[0] }) : 'unknown';
  }
  if (schema?.type === 'integer' || schema?.type === 'number') return 'number';
  if (schema?.type === 'boolean') return 'boolean';
  if (schema?.type === 'array') return 'array';
  if (schema?.type === 'object' || schema?.properties || schema?.additionalProperties) return 'object';
  if (schema?.type === 'string' || schema?.enum || schema?.format) return 'string';
  return 'unknown';
}
function dereferenceObject(value, root, activeRefs = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (typeof value.$ref !== 'string') return value;
  const ref = value.$ref;
  if (activeRefs.has(ref)) return value;
  const nextRefs = new Set(activeRefs);
  nextRefs.add(ref);
  const target = dereferenceObject(resolveLocalRef(ref, root), root, nextRefs);
  const siblings = { ...value };
  delete siblings.$ref;
  return target && typeof target === 'object' && !Array.isArray(target)
    ? { ...target, ...siblings }
    : siblings;
}

function normalizeParameter(parameter, path) {
  const location = parameter.in;
  if (!['path', 'query', 'header', 'cookie'].includes(location) || typeof parameter.name !== 'string') {
    fail(`Unsupported parameter shape on ${path}`);
  }
  const schema = parameter.schema ?? (parameter.content ? parameter.content['application/json']?.schema : undefined);
  if (!schema) fail(`Parameter ${parameter.name} on ${path} has no representable schema`);
  const resolvedSchema = resolveTree(schema, schemaRoot);
  const style = parameter.style ?? (location === 'query' || location === 'cookie' ? 'form' : undefined);
  if (style && !['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'].includes(style)) {
    fail(`Unsupported parameter style ${style} for ${parameter.name} on ${path}`);
  }
  return {
    name: parameter.name,
    location,
    kind: kindOf(resolvedSchema),
    required: location === 'path' ? true : Boolean(parameter.required),
    ...(parameter.description ? { description: parameter.description } : {}),
    ...(Array.isArray(resolvedSchema.enum) ? { enumValues: resolvedSchema.enum } : {}),
    ...(Object.hasOwn(resolvedSchema, 'default') ? { defaultValue: resolvedSchema.default } : {}),
    ...(style ? { style } : {}),
    ...(parameter.explode !== undefined ? { explode: parameter.explode } : style ? { explode: style === 'form' } : {}),
    ...(parameter.deprecated ? { deprecated: true } : {}),
    schema,
  };
}

function parametersFor(pathItem, operation, path) {
  const byIdentity = new Map();
  for (const raw of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = dereferenceObject(raw, schemaRoot);
    const normalized = normalizeParameter(parameter, path);
    byIdentity.set(`${normalized.location}:${normalized.name}`, normalized);
  }
  return [...byIdentity.values()];
}

let schemaRoot;

function resourceFor(apiPath) {
  const segments = apiPath.split('/').filter(Boolean);
  if (segments[0] !== 'api' || segments.length < 3) return { resource: 'system', resourceLabel: 'System' };
  const app = segments[1];
  const model = segments[2].startsWith('{') ? null : segments[2];
  if (!model) return { resource: 'system', resourceLabel: 'System' };
  const title = (text) => text.split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ');
  return { resource: `${app}/${model}`, resourceLabel: `${app.toUpperCase()}: ${title(model)}` };
}

const ACTIONS = new Map([
  ['trace', 'Trace'], ['render-config', 'Render Config'], ['render', 'Render'], ['run', 'Run'],
  ['upload', 'Upload'], ['sync', 'Sync'], ['paths', 'Get Paths'], ['elevation', 'Get Elevation'],
  ['choices', 'Get Choices'], ['enqueue', 'Enqueue'], ['requeue', 'Requeue'], ['stop', 'Stop'],
  ['delete', 'Delete'], ['available-ips', 'Get Available IPs'], ['available-prefixes', 'Get Available Prefixes'],
  ['available-vlans', 'Get Available VLANs'], ['available-asns', 'Get Available ASNs'],
]);

const ALLOCATION_ACTIONS = new Map([
  ['available-ips', 'Allocate IPs'], ['available-prefixes', 'Allocate Prefixes'],
  ['available-vlans', 'Allocate VLANs'], ['available-asns', 'Allocate ASNs'],
]);

function humanize(text) {
  const special = new Map([['ips', 'IPs'], ['ip', 'IP'], ['asns', 'ASNs'], ['asn', 'ASN'], ['vlans', 'VLANs'], ['vlan', 'VLAN'], ['ids', 'IDs'], ['id', 'ID'], ['api', 'API']]);
  return text.split(/[-_]/).filter(Boolean).map((part) => special.get(part.toLowerCase()) ?? part[0].toUpperCase() + part.slice(1)).join(' ');
}

function operationLabel(method, apiPath, operationId) {
  const parts = apiPath.split('/').filter(Boolean).slice(2);
  const detail = parts.some((part) => /^\{[^}]+\}$/.test(part));
  const afterDetail = parts.findIndex((part) => /^\{[^}]+\}$/.test(part));
  const action = afterDetail >= 0 ? parts.slice(afterDetail + 1).filter((part) => !/^\{[^}]+\}$/.test(part)).at(-1) : null;
  const collectionAction = !detail && parts.length > 1 ? parts.at(-1) : null;
  const operationVerb = operationId.split('_').at(-1);
  if (collectionAction && method === 'POST' && ALLOCATION_ACTIONS.has(collectionAction)) {
    return ALLOCATION_ACTIONS.get(collectionAction);
  }
  if (action) {
    if (ALLOCATION_ACTIONS.has(action) && method === 'POST') return ALLOCATION_ACTIONS.get(action);
    return ACTIONS.get(action) ?? humanize(action);
  }
  if (collectionAction && ACTIONS.has(collectionAction)) return ACTIONS.get(collectionAction);
  if (operationVerb === 'run' || operationVerb === 'upload') return ACTIONS.get(operationVerb);
  if (method === 'GET') return detail ? 'Get' : 'Get Many';
  if (method === 'POST') return 'Create';
  if (method === 'PATCH') return detail ? 'Update' : 'Update Many';
  if (method === 'PUT') return detail ? 'Replace' : 'Replace Many';
  if (method === 'DELETE') return detail ? 'Delete' : 'Delete Many';
  return method === 'HEAD' ? (detail ? 'Check' : 'Check Many') : 'Options';
}

function binaryMetadata(schema) {
  const resolved = resolveTree(schema, schemaRoot);
  const fields = new Set();
  const requiredNames = new Set();
  const visited = new Set();
  const containsBinary = (value) => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsBinary);
    if (value.format === 'binary' || value.type === 'file') return true;
    return containsBinary(value.items) || ['allOf', 'oneOf', 'anyOf'].some((key) =>
      Array.isArray(value[key]) && value[key].some(containsBinary));
  };
  const visit = (value) => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    visited.add(value);
    for (const name of value.required ?? []) if (typeof name === 'string') requiredNames.add(name);
    if (value.properties && typeof value.properties === 'object') {
      for (const [name, field] of Object.entries(value.properties)) {
        if (containsBinary(field)) fields.add(name);
      }
    }
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
      if (Array.isArray(value[key])) for (const variant of value[key]) visit(variant);
    }
    visit(value.items);
  };
  visit(resolved);
  const binaryFields = [...fields].sort();
  return {
    binaryFields,
    requiredBinaryFields: binaryFields.filter((name) => requiredNames.has(name)),
  };
}

function requestBody(operation, apiPath) {
  if (!operation.requestBody) return undefined;
  resolveTree(operation.requestBody, schemaRoot);
  const body = dereferenceObject(operation.requestBody, schemaRoot);
  if (!body.content || typeof body.content !== 'object') fail(`Unsupported request body on ${apiPath}`);
  const contentTypes = Object.entries(body.content).map(([contentType, rawMedia]) => {
    const media = dereferenceObject(rawMedia, schemaRoot);
    if (!media || typeof media !== 'object') fail(`Unsupported request media type ${contentType} on ${apiPath}`);
    const schema = media.schema;
    const binary = schema ? binaryMetadata(schema) : { binaryFields: [], requiredBinaryFields: [] };
    return {
      contentType,
      ...(schema ? { schema } : {}),
      ...binary,
    };
  });
  for (const media of contentTypes) {
    if (media.contentType !== 'application/json' && media.contentType !== 'multipart/form-data') {
      fail(`Unsupported request media type ${media.contentType} on ${apiPath}`);
    }
  }
  if (!contentTypes.length) fail(`Request body has no media types on ${apiPath}`);
  return { required: Boolean(body.required), contentTypes };
}

function responseVariants(operation, apiPath) {
  const responses = operation.responses ?? {};
  if (!Object.keys(responses).length) fail(`Operation has no responses on ${apiPath}`);
  const variants = [];
  let hasEnvelope = false;
  for (const [statusCode, rawResponse] of Object.entries(responses)) {
    resolveTree(rawResponse, schemaRoot);
    const response = dereferenceObject(rawResponse, schemaRoot);
    if (!response || typeof response !== 'object') fail(`Unsupported response ${statusCode} on ${apiPath}`);
    const content = response.content ?? {};
    if (!Object.keys(content).length) {
      variants.push({ statusCode, contentType: '' });
      continue;
    }
    for (const [contentType, rawMedia] of Object.entries(content)) {
      const media = dereferenceObject(rawMedia, schemaRoot);
      const schema = media?.schema;
      const resolvedSchema = schema ? resolveTree(schema, schemaRoot) : undefined;
      if (statusCode.startsWith('2') && schemaHasEnvelope(resolvedSchema)) hasEnvelope = true;
      variants.push({
        statusCode,
        contentType,
        ...(schema ? { schema } : {}),
      });
    }
  }
  return { variants, hasEnvelope };
}

function schemaHasEnvelope(schema) {
  if (!schema || typeof schema !== 'object') return false;
  const properties = new Set();
  const collectAllOf = (part) => {
    for (const property of Object.keys(part?.properties ?? {})) properties.add(property);
    for (const nested of part?.allOf ?? []) collectAllOf(nested);
  };
  collectAllOf(schema);
  if (properties.has('results') && properties.has('next')) return true;
  return [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])].some(schemaHasEnvelope);
}

function operationRecords(schema) {
  if (!schema.paths || typeof schema.paths !== 'object' || Array.isArray(schema.paths)) fail('OpenAPI schema has no paths object');
  schemaRoot = schema;
  const records = [];
  const ids = new Set();
  for (const [apiPath, pathItemRaw] of Object.entries(schema.paths).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const pathItem = dereferenceObject(pathItemRaw, schemaRoot);
    for (const key of Object.keys(pathItem)) {
      if (!METHODS.has(key.toLowerCase()) && !PATH_ITEM_KEYS.has(key) && !key.startsWith('x-')) {
        fail(`Unsupported path item field ${key} on ${apiPath}`);
      }
    }
    for (const methodKey of Object.keys(pathItem).filter((key) => METHODS.has(key.toLowerCase())).sort()) {
      const method = methodKey.toUpperCase();
      const operation = dereferenceObject(pathItem[methodKey], schemaRoot);
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail(`Unsupported ${method} operation shape on ${apiPath}`);
      if (typeof operation.operationId !== 'string' || !operation.operationId.trim()) fail(`Missing operationId for ${method} ${apiPath}`);
      if (ids.has(operation.operationId)) fail(`Duplicate operationId: ${operation.operationId}`);
      ids.add(operation.operationId);
      const params = parametersFor(pathItem, operation, apiPath);
      const pathParameters = params.filter((parameter) => parameter.location === 'path');
      const expectedPathParameters = [...apiPath.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const name of expectedPathParameters) {
        if (!pathParameters.some((parameter) => parameter.name === name)) fail(`Missing required path parameter ${name} for ${method} ${apiPath}`);
      }
      for (const parameter of pathParameters) {
        if (!expectedPathParameters.includes(parameter.name)) fail(`Path parameter ${parameter.name} is not present in ${apiPath}`);
      }
      if (params.some((parameter) => parameter.location === 'cookie')) fail(`Cookie parameters cannot be represented for ${method} ${apiPath}`);
      const { resource, resourceLabel } = resourceFor(apiPath);
      const summary = `${method} ${apiPath} — ${operation.summary ?? operation.description ?? operation.operationId}`;
      const responseData = responseVariants(operation, apiPath);
      records.push({
        method,
        id: operation.operationId,
        resource,
        resourceLabel,
        summary,
        label: operationLabel(method, apiPath, operation.operationId),
        path: apiPath,
        pathParameters,
        queryParameters: params.filter((parameter) => parameter.location === 'query'),
        headerParameters: params.filter((parameter) => parameter.location === 'header'),
        ...(operation.requestBody ? { requestBody: requestBody(operation, apiPath) } : {}),
        responses: responseData.variants,
        paginated: method === 'GET' && responseData.hasEnvelope,
        deprecated: Boolean(operation.deprecated),
      });
    }
  }
  const labels = new Map();
  for (const operation of records) {
    const key = `${operation.resource}\0${operation.label}`;
    const siblings = labels.get(key) ?? [];
    siblings.push(operation);
    labels.set(key, siblings);
  }
  for (const siblings of labels.values()) {
    if (siblings.length < 2) continue;
    for (const operation of siblings) {
      const resourceSegments = operation.resource.split('/').slice(1);
      const remainingPath = operation.path.split('/').filter(Boolean).slice(2 + resourceSegments.length);
      const discriminator = remainingPath.filter((part) => !/^\{[^}]+\}$/.test(part)).at(-1)
        ?? (remainingPath.length ? 'detail' : operation.path.split('/').filter(Boolean).slice(-1)[0]);
      operation.label = `${operation.label} ${humanize(discriminator)}`;
    }
  }
  const remaining = new Set();
  for (const operation of records) {
    const key = `${operation.resource}\0${operation.label}`;
    if (remaining.has(key)) fail(`Unable to resolve label collision: ${operation.resource} / ${operation.label}`);
    remaining.add(key);
  }
  return records;
}

function resourcesFor(operations) {
  const resources = new Map();
  for (const operation of operations) resources.set(operation.resource, operation.resourceLabel);
  return [...resources].map(([value, label]) => ({ value, label })).sort((a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
}

async function main() {
  const { schema, source } = await loadInput();
  if (!/^3\.0\.\d+$/.test(schema.openapi ?? '')) fail(`Expected OpenAPI 3.0.x, received ${schema.openapi ?? 'missing'}`);
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  if (!String(schema.info?.version ?? '').startsWith('4.7.3')) fail(`Expected NetBox version starting with 4.7.3, received ${schema.info?.version ?? 'missing'}`);
  if (manifest.upstreamReleaseCommit !== '3cd2c1d6469caed6c50e80eddd4cde863e0e2cf5') fail('Pinned upstream release commit does not match the documented 4.7.3 commit');
  const inputBytes = Buffer.from(JSON.stringify(schema));
  if (source === DEFAULT_INPUT && createHash('sha256').update(await readFile(DEFAULT_INPUT)).digest('hex') !== manifest.sha256) {
    fail('Checked-in schema SHA-256 does not match scripts/schema/manifest.json');
  }
  const operations = operationRecords(schema);
  const expectedCount = source === DEFAULT_INPUT ? manifest.operationCount : null;
  if (source === DEFAULT_INPUT && Object.keys(schema.paths).length !== manifest.pathCount) {
    fail(`Schema path count mismatch: expected ${manifest.pathCount}, found ${Object.keys(schema.paths).length}`);
  }
  if (expectedCount !== null && operations.length !== expectedCount) fail(`Schema operation count mismatch: expected ${expectedCount}, found ${operations.length}`);
  const resources = resourcesFor(operations);
  const outputJson = path.join(ROOT, 'nodes/NetBoxConnector/catalog/operations.generated.json');
  const outputTs = path.join(ROOT, 'nodes/NetBoxConnector/catalog/operations.generated.ts');
  await writeFile(outputJson, `${JSON.stringify({ operations, resources })}\n`);
  const ts = `/* Generated by scripts/generate-catalog.mjs; do not edit. */\nimport type { ApiOperation, ApiResource } from './types';\n\nconst catalog = require('./operations.generated.json') as { operations: ApiOperation[]; resources: ApiResource[] };\nexport const OPERATIONS = catalog.operations;\nexport const RESOURCES = catalog.resources;\n`;
  await writeFile(outputTs, ts);
  process.stdout.write(`Generated ${operations.length} operations across ${resources.length} resources from ${inputBytes.length} schema bytes.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
