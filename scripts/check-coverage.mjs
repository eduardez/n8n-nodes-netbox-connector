#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

function key(method, apiPath) {
  return `${method.toUpperCase()} ${apiPath}`;
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

async function main() {
  const [schema, generated, manifest] = await Promise.all([
    readFile(path.join(ROOT, 'scripts/schema/netbox-4.7.3.openapi.json'), 'utf8').then(JSON.parse),
    readFile(path.join(ROOT, 'nodes/NetBoxConnector/catalog/operations.generated.json'), 'utf8').then(JSON.parse),
    readFile(path.join(ROOT, 'scripts/schema/manifest.json'), 'utf8').then(JSON.parse),
  ]);
  const expected = new Set();
  for (const [apiPath, pathItem] of Object.entries(schema.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (METHODS.has(method.toLowerCase())) expected.add(key(method, apiPath));
    }
  }
  const actual = new Set();
  const duplicate = [];
  const ids = new Set();
  for (const operation of generated.operations ?? []) {
    const operationKey = key(operation.method, operation.path);
    if (actual.has(operationKey)) duplicate.push(operationKey);
    actual.add(operationKey);
    if (ids.has(operation.id)) duplicate.push(`duplicate operationId ${operation.id}`);
    ids.add(operation.id);
  }
  const missing = sorted([...expected].filter((entry) => !actual.has(entry)));
  const extra = sorted([...actual].filter((entry) => !expected.has(entry)));
  if (missing.length || extra.length || duplicate.length || expected.size !== manifest.operationCount) {
    process.stderr.write(`Coverage mismatch (schema ${expected.size}, generated ${actual.size}, manifest ${manifest.operationCount}).\n`);
    if (missing.length) process.stderr.write(`Missing (${missing.length}):\n${missing.map((entry) => `  ${entry}`).join('\n')}\n`);
    if (extra.length) process.stderr.write(`Extra (${extra.length}):\n${extra.map((entry) => `  ${entry}`).join('\n')}\n`);
    if (duplicate.length) process.stderr.write(`Duplicates (${duplicate.length}):\n${sorted(duplicate).map((entry) => `  ${entry}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Exact operation coverage: ${actual.size} methods across ${Object.keys(schema.paths).length} paths.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
