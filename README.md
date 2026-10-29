# n8n-nodes-netbox-connector

Repository: [n8n-nodes-netbox-connector](https://github.com/eduardez/n8n-nodes-netbox-connector) · Homepage: [README](https://github.com/eduardez/n8n-nodes-netbox-connector#readme) · npm package: [n8n-nodes-netbox-connector](https://www.npmjs.com/package/n8n-nodes-netbox-connector) · Issues: [GitHub Issues](https://github.com/eduardez/n8n-nodes-netbox-connector/issues)

Contributions are welcome—feel free to contribute!

n8n community node for NetBox REST and read-only GraphQL APIs

## Install

Install `n8n-nodes-netbox-connector` from **Settings → Community Nodes** in n8n, or install the package in the n8n instance's custom-node environment. Restart n8n after installation.

## Credentials

Create **NetBox API** credentials:

- **Base URL**: NetBox deployment root, optionally including a reverse-proxy subpath, such as `https://netbox.example.com/netbox`. Do not append `/api` or `/graphql`
- **Token Type**: Version 2 (Bearer) or Version 1 (Token). Version 1 tokens are deprecated in NetBox 4.6 and later
- **API Token**: full `nbt_<key>.<token>` v2 token or plaintext v1 token
- **Allow Unauthorized Certificates**: disables TLS certificate validation. Use only for trusted self-signed NetBox deployments

Credential testing first calls `/api/authentication-check/`. If that endpoint is absent (HTTP 404), it probes the protected, read-only `/api/users/users/?limit=1`; an explicit permission-denied response is accepted only when it confirms the token authenticated but lacks user-list permission. It never falls back to unauthenticated `/api/status/`. Requests use the configured origin and deployment subpath; caller-supplied `Authorization`, `Host`, and `Cookie` headers cannot override transport security.

## Resources

### Native REST

The **Resource** and **Operation** selectors cover every method/path operation in the pinned NetBox 4.7.3 OpenAPI schema: 1,256 operations, 322 paths, and 146 resource groups. The committed schema is the public NetBox demo schema pinned to the v4.7.3 source commit; it is not a capture from a local NetBox instance.
The catalog targets NetBox 4.7.3. With older releases such as 4.3.0, only endpoints present on the target are usable; other version-specific operation behavior is not verified.

- Path parameters appear for the selected operation
- **Query Parameters** and **Headers** accept JSON objects. Query arrays and OpenAPI parameter styles are serialized from the schema
- **Options** exposes NetBox `fields`, `omit`, `brief`, and `ordering` where supported. `fields` takes precedence over `omit`
- Request bodies pass JSON objects, arrays, scalars, and `null` unchanged. Multipart requests accept text fields and mappings from n8n input binary properties
- Binary responses are emitted as n8n binary data; **Include Response Metadata** returns the raw body, HTTP status, and response headers
- Paginated GET operations follow same-origin NetBox `next` URLs, retain filters, and stop repeated cursors. Set **Return All** or use **Limit** and **Page Size**. Do not set `queryParameters.limit` while automatic pagination is enabled

### Custom REST

**Custom REST → Request** supports GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS under `/api/`. Configure JSON query parameters and headers, and choose no body, JSON, raw text, URL-encoded, multipart, or binary input. Choose JSON, text, or binary response handling. Requests cannot change the configured origin or override the authentication header.

GET and HEAD requests do not accept a body. For multipart or binary requests, map input binary fields to the NetBox form field names. Binary responses are stored under **Output Binary Field**.

### GraphQL

**GraphQL → Query** sends POST requests to the fixed `/graphql/` endpoint. It accepts a query document, optional operation name, and JSON variables. The node parses documents before sending and rejects mutations and subscriptions; GraphQL `data` and `errors` are preserved in the output.

### Helpers

- **Get Available IPs**: read available addresses from a Prefix or IP Range
- **Allocate IP**: allocate from a Prefix or IP Range using the NetBox array request shape
- **Get Available Prefixes**: read available subprefixes from a Prefix
- **Allocate Prefix**: allocate one or more subprefixes; every request entry requires `prefix_length`
- **Assign IP to Interface**: assign an existing IP address to an interface

Array responses produce one n8n item per element. Helpers and all resources use the same credentials, timeout validation, error handling, and redaction.

## Errors and output

HTTP failures include the status and redacted NetBox response details. With **Continue On Fail**, the node emits an error item for the failing input item and continues; successful outputs retain input-item pairing. A 204 or HEAD response produces an empty JSON object unless response metadata is enabled.

## Development

```sh
npm install
npm run generate
npm run check:coverage
npm test
npm run lint
npm pack --dry-run
```

The generator uses `scripts/schema/netbox-4.7.3.openapi.json` by default. `npm run generate -- --input <path-or-url>` accepts a replacement OpenAPI document; remote authenticated inputs use `NETBOX_TOKEN` and optional `NETBOX_TOKEN_TYPE`. Generated runtime catalog files are checked in.

## CI/CD

Pull requests, pushes to `main` or `develop`, and manual dispatch run **CI** on Node.js 20 and 22. It installs locked dependencies, builds, checks generated-operation coverage, runs lint and tests, and verifies `npm pack --dry-run`.

CI dispatch also accepts `run_integration` (default false). Set it to true to run `npm run test:integration` against a disposable NetBox instance; configure `NETBOX_BASE_URL`, `NETBOX_API_TOKEN`, and `NETBOX_TEST_PREFIX_ID`. Confirm the target is disposable before dispatch. The create/delete tag scenario remains disabled unless **Allow writes** is selected; choose token type `v1` or `v2`.

Every change merged to `main` triggers `publish.yml`. Conventional Commits select the version: `fix:` is patch, `feat:` is minor, and `feat!:` or `BREAKING CHANGE:` is major. Other commit types, including `docs` and `chore`, produce a patch release.

The source `package.json` may retain its development version. The release runner sets the calculated version only in the npm artifact; its `vX.Y.Z` tag and GitHub release refer to the same source commit and version.

For recovery after a failed automatic publish, dispatch **Actions → Publish → Run workflow** from `main` with the exact version of the existing `vX.Y.Z` tag. The workflow builds that tag's commit, requires it to be an ancestor of `main`, and skips an existing npm version only when its registry `gitHead` matches. With no existing tag, a manual version must exceed both the highest stable git tag and npm `latest`. The workflow never commits or pushes a version change to `main`.

Configure the npm **Trusted Publisher** for owner `eduardez`, repository `n8n-nodes-netbox-connector`, and workflow filename `publish.yml` only. Leave the environment blank and allow direct `npm publish`; the workflow uses Node 22 and npm 11.19.0 with OIDC, not an npm token.

## Live integration tests

`npm run test:integration` runs the compiled node against a disposable NetBox instance. Set `NETBOX_INTEGRATION_DISPOSABLE=1`, `NETBOX_BASE_URL`, `NETBOX_API_TOKEN`, and `NETBOX_TEST_PREFIX_ID`; `NETBOX_TOKEN_TYPE` defaults to `v2`. The suite covers native paginated REST, Custom REST metadata, a read-only GraphQL query, and IPAM read helpers.

The create/delete tag scenario is skipped unless `NETBOX_INTEGRATION_ALLOW_WRITES=1`. It creates a uniquely named tag and deletes it in `finally`. Do not point these tests at shared or production NetBox instances.

```sh
NETBOX_INTEGRATION_DISPOSABLE=1 \
NETBOX_BASE_URL='https://<disposable-netbox>' \
NETBOX_API_TOKEN='<token>' \
NETBOX_TEST_PREFIX_ID='<prefix-id>' \
npm run test:integration
```

The integration harness executes the compiled node with an HTTP adapter; it does not launch an n8n server or verify the browser UI.

## Changelog

- **0.1.1** — Add a protected credential-test fallback for NetBox releases without `/api/authentication-check/`.
- **0.1.0** — Initial NetBox 4.7.3 catalog, authenticated transport, Custom REST, read-only GraphQL, and IPAM provisioning helpers

NetBox is a registered trademark of NetBox Labs. The network-symbol artwork is derived from the official NetBox logo at <https://github.com/netbox-community/netbox/blob/v4.7.3/netbox/project-static/img/logo_netbox_bright_teal.svg> and is used here as the symbol portion only. The full source logo is copyrighted by its respective owner.


