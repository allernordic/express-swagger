# @aller/express-swagger

[![Build](https://github.com/allernordic/express-swagger/actions/workflows/build.yaml/badge.svg)](https://github.com/allernordic/express-swagger/actions/workflows/build.yaml)

Builds an OpenAPI 3 document for an Express application, derived from the app's registered routes and the JSDoc types those routes declare. You choose how to serve the result — pre-build once and serve it as a static file, or build on demand inside a request handler.

<!-- toc -->

- [What it does](#what-it-does)
- [Installation](#installation)
- [Annotating routes](#annotating-routes)
- [Declaring response types](#declaring-response-types)
  - [Success responses](#success-responses)
    - [Pinning the success status on the handler signature](#pinning-the-success-status-on-the-handler-signature)
  - [Error responses](#error-responses)
    - [Multi-status success via `@throws {CreatedResponse<T>}`](#multi-status-success-via-throws-createdresponset)
- [Type-to-schema notes](#type-to-schema-notes)
- [Using the CLI to pre-build `swagger.json`](#using-the-cli-to-pre-build-swaggerjson)
  - [Loading the generated `swagger.json` from your app](#loading-the-generated-swaggerjson-from-your-app)
- [Writing your own pre-build script](#writing-your-own-pre-build-script)
  - [Security example](#security-example)
- [Serving on demand](#serving-on-demand)
- [Smallest working example](#smallest-working-example)
- [Debug](#debug)

<!-- /toc -->

## What it does

- Walks the Express app's router and emits one OpenAPI operation per `(method, path)` pair — multiple methods on the same path share a single path entry.
- Reads per-route request / response / path-params / query types and error responses from JSDoc `@param` and `@throws` tags on each handler.
- When given a `tsconfig.json`, compiles it with TypeScript's programmatic API and turns each type referenced from a handler into a JSON Schema under `components.schemas`. Without one, the doc still builds — request/response bodies fall back to `{ type: 'object' }` stubs.
- Success status and error status codes are both driven by the response body type — no method-based heuristics, no `res.status(N)` sniffing.

Requires `typescript` as a peer dependency.

## Installation

```bash
npm install @aller/express-swagger
npm install --save-dev typescript
```

## Annotating routes

Routes are annotated inline via a JSDoc comment on the handler. Body shapes are declared with `@typedef` (or pulled from a `.d.ts` via `import(...)`); the response status is pinned via `ApiResponse<Body, NNN>` and error responses are declared with `@throws`:

```js
/** @typedef {{ name: string, email: string }} CreateUserBody */
/** @typedef {{ id: string, name: string, email: string }} UserRecord */
/** @typedef {{ message: string }} ErrorBody */

/** @typedef {import('@aller/express-swagger').ApiResponse<UserRecord, 201>} CreateUserResponse */
/** @typedef {import('@aller/express-swagger').NoContentResponse} DeleteUserResponse */

/**
 * `Request<P, ResBody, …>` already pins the response body, so leaving
 * `@param {Response} res` bare reuses it — emits 200 with `UserRecord[]`.
 * @param {import('express').Request<{}, UserRecord[]>} _req
 * @param {import('express').Response} _res
 */
function listUsers(_req, _res) {
  /* ... */
}
app.get('/users', listUsers);

/**
 * @param {import('express').Request<{ id: string }, UserRecord>} _req
 * @param {import('express').Response<UserRecord>} _res
 * @throws {import('@aller/express-swagger').NotFoundResponse<ErrorBody>}
 */
function getUser(_req, _res) {
  /* ... */
}
app.get('/users/:id', getUser);

/**
 * `CreateUserResponse` aliases `ApiResponse<UserRecord, 201>` (above) — the
 * `, 201` literal in the alias pins the success status. The handler stays
 * a normal Express handler: `_res` is `Response<CreateUserResponse>`.
 * @param {import('express').Request<{}, CreateUserResponse, CreateUserBody>} _req
 * @param {import('express').Response<CreateUserResponse>} _res
 * @throws {import('@aller/express-swagger').BadRequestResponse<ErrorBody>}
 */
function createUser(_req, _res) {
  /* ... */
}
app.post('/users', createUser);

/**
 * @param {import('express').Request<{ id: string }, UserRecord, CreateUserBody>} _req
 * @param {import('express').Response<UserRecord>} _res
 * @throws {import('@aller/express-swagger').NotFoundResponse<ErrorBody>}
 * @throws {import('@aller/express-swagger').BadRequestResponse<ErrorBody>}
 */
function updateUser(_req, _res) {
  /* ... */
}
app.put('/users/:id', updateUser);

app.delete(
  '/users/:id',
  /**
   * `DeleteUserResponse` aliases `NoContentResponse` → 204 with no `content` block.
   * @param {import('express').Request<{ id: string }>} _req
   * @param {import('express').Response<DeleteUserResponse>} _res
   * @throws {import('@aller/express-swagger').NotFoundResponse<ErrorBody>}
   */
  (_req, _res) => {
    /* ... */
  }
);
```

What you get back: `GET /users` → 200 with `UserRecord[]`, `GET /users/{id}` → 200 + 404, `POST /users` → 201 + 400, `PUT /users/{id}` → 200 + 400 + 404, `DELETE /users/{id}` → 204 + 404. `components.schemas` carries `UserRecord`, `CreateUserBody`, and `ErrorBody`.

Signals the library reads from a handler:

| Source                                                                | Meaning                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@param {Request<Params, ResBody, ReqBody, Query>} req [description]` | Path-param / response-body / request-body / query-string schema types (any slot is optional). Trailing free text becomes the requestBody description.                                                                                                                                               |
| `@param {Response<Body>} res [description]`                           | Response body schema — also drives the success status (see below). Trailing free text becomes the success-response description.                                                                                                                                                                     |
| `@throws {TypeName} [description]`                                    | Error response. `TypeName` must resolve to a library error type (see below). Trailing free text becomes the response description.                                                                                                                                                                   |
| `@tag <name>`                                                         | OpenAPI tag for grouping endpoints. Repeat the tag for multiple values (order is preserved).                                                                                                                                                                                                        |
| `@security <scheme> [arg …]`                                          | Security requirement. `<scheme>` must match a declared `securitySchemes` key. For `apiKey` the next token is the header name; for `openIdConnect` an `https?://…` token is taken as the issuer URL (both auto-emit the scheme). All remaining tokens are OAuth2/OIDC scopes. Repeat the tag for OR. |
| `@deprecated [message]`                                               | Sets `deprecated: true`. An optional message is appended to `description` as `**Deprecated:** …`.                                                                                                                                                                                                   |
| `@private` / `@ignore` / `@protected`                                 | Skip this handler — it's omitted from the OpenAPI doc entirely. Any of the three tags works.                                                                                                                                                                                                        |

Path parameters are extracted from the Express path (`/users/:id` → `/users/{id}`) and their schema is taken from the `Params` slot of `Request<…>`. Without a `Params` type, each `:name` parameter defaults to `{ type: 'string' }`.

A `@throws` whose type doesn't ultimately resolve to one of the library's error types is silently dropped — the entry is ignored rather than emitted as an unknown status.

If `@param {Request<Params, ResBody, …>}` already pins the response body, you can leave the `@param {Response} res` bare (no generic) and the library will reuse `ResBody` from the request slot — saves writing the same type twice. An explicit `Response<X>` always wins when present.

## Declaring response types

The library exports a small set of types whose names carry status-code meaning. Reference them either directly or via a chain (type alias or `interface … extends …`); chains of any depth are walked.

### Success responses

| Library type         | Status | Wire body                                            |
| -------------------- | ------ | ---------------------------------------------------- |
| `CreatedResponse<T>` | 201    | `T` (identity alias — the wire body is `T` as-is)    |
| `NoContentResponse`  | 204    | _none_ — aliased to `never`, forcing `res.end()` use |
| _anything else_      | 200    | The response body type declared in `Response<…>`.    |

`NoContentResponse = never` is deliberate: it makes `res.json(…)` uncallable in typed handlers, so a 204 endpoint must use `res.status(204).end()`.

#### Pinning the success status on the handler signature

The library exports `ApiResponse<ResBody, StatusCode>` — two template parameters, no Express inheritance. Alias it via a JSDoc `@typedef`, then use that alias as the body of `Response<…>` so `_res` stays a structurally-correct Express `Response`:

```js
/** @typedef {import('@aller/express-swagger').ApiResponse<UserRecord, 202>} PutAvatarResponse */

/**
 * @param {import('express').Request<{ id: string }>} _req
 * @param {import('express').Response<PutAvatarResponse>} _res
 */
function putAvatar(_req, _res) {
  /* ... */
}
app.put('/users/:id/avatar', putAvatar);
```

The `, 202` literal in the alias drives the operation's success status. Without an explicit pin, the existing rules apply: the response body type's chain to `ApiResponse<T, NNN>` wins (e.g. `CreatedResponse<T>` → 201), otherwise 200.

Example — declaring a 204 endpoint:

```ts
// types.d.ts
import type { NoContentResponse } from '@aller/express-swagger';

export type DeleteUserResponse = NoContentResponse;
```

```js
// routes.js
/** @typedef {import('./types.js').DeleteUserResponse} DeleteUserResponse */

app.delete(
  '/users/:id',
  /**
   * @param {import('express').Request<{ id: string }>} _req
   * @param {import('express').Response<DeleteUserResponse>} res
   */
  (_req, res) => {
    res.status(204).end();
  }
);
```

The emitted operation has `responses: { '204': { description: '' } }` with no `content` block.

### Error responses

Declared via `@throws {YourErrorType}`. The type must ultimately refer to one of:

| Library type                     | Status |
| -------------------------------- | ------ |
| `BadRequestResponse<T>`          | 400    |
| `UnauthorizedResponse<T>`        | 401    |
| `ForbiddenResponse<T>`           | 403    |
| `NotFoundResponse<T>`            | 404    |
| `ConflictResponse<T>`            | 409    |
| `InternalServerErrorResponse<T>` | 500    |
| `BadGatewayResponse<T>`          | 502    |

All extend `ErrorResponse<T, NNN>` and carry the body on a `body` property. The second generic on `ErrorResponse` pins the HTTP status as a numeric literal — declare your own error type with any code you need and the library reads the status straight off the type chain:

```ts
import type { ErrorResponse } from '@aller/express-swagger';

export interface TeapotResponse<T> extends ErrorResponse<T, 418> {}
export type CreateUserTeapotResponse = TeapotResponse<ErrorBody>;
```

A handler annotated with `@throws {CreateUserTeapotResponse}` gets a `418` response in the OpenAPI doc — no need to wait for a registry update or pass anything to `options.security`/`options.statuses`.

#### Multi-status success via `@throws {CreatedResponse<T>}`

`@throws` accepts any library status type, not just error types. To document a POST endpoint that returns either `200` or `201` depending on whether a record already existed, declare the success body via `Response<T>` (defaults to 200) and add `@throws {CreatedResponse<U>}` to surface the alternative 201:

```js
app.post(
  '/notes',
  /**
   * @param {import('express').Request<{}, NoteRecord, CreateNoteRequest>} req
   * @param {import('express').Response<NoteRecord>} res
   * @throws {import('@aller/express-swagger').CreatedResponse<NoteRecord>}
   */
  (req, res) => {
    /* ... */
  }
);
```

The doc emits both responses: `200` with `NoteRecord` (the default success) and `201` with `NoteRecord` (from the throws). Same trick works with `NoContentResponse` — `@throws {NoContentResponse}` adds a bodyless `204` next to whatever the handler's `Response<…>` declares.

Example — declare the fixture types once, reuse them across handlers:

```ts
// types.d.ts
import type {
  BadRequestResponse,
  ConflictResponse,
  CreatedResponse,
  ForbiddenResponse,
  InternalServerErrorResponse,
  NoContentResponse,
  NotFoundResponse,
  UnauthorizedResponse,
} from '@aller/express-swagger';

export interface UserRecord {
  id: string;
  name: string;
  email: string;
}
export interface ErrorBody {
  error: string;
}

export type CreateUserResponse = CreatedResponse<UserRecord>;
export type DeleteUserResponse = NoContentResponse;
export type CreateUserNotFoundResponse = NotFoundResponse<ErrorBody>;
export type CreateUserConflictResponse = ConflictResponse<ErrorBody>;

// Alias / extends chains work too — the library walks them.
type AliasedBadRequest = BadRequestResponse<ErrorBody>;
export type LoginBadRequestResponse = AliasedBadRequest;
export interface DeleteUserBadRequestResponse extends BadRequestResponse<ErrorBody> {}
```

## Type-to-schema notes

Most TypeScript types map cleanly to OpenAPI 3 schemas. A handful of corner cases are worth knowing:

| Source type                                                  | Schema                                                                                                                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bigint`                                                     | `{ type: 'number' }` — OpenAPI 3 has no bigint type.                                                                                                                                       |
| `Date`                                                       | `{ type: 'string', format: 'date-time' }` (instance methods aren't walked).                                                                                                                |
| `Number` / `String` / `Boolean` (deprecated wrapper objects) | Coerced to their primitive equivalents.                                                                                                                                                    |
| `Symbol` / `Object` (deprecated wrapper objects), `symbol`   | Properties of these types are dropped from the schema; standalone, the schema collapses to `{}`. The lowercase `symbol` primitive can't be JSON-serialized, so it gets the same treatment. |
| `any` / `unknown` / `never` / `void`                         | `{}` (matches anything).                                                                                                                                                                   |

Prefer the lowercase primitives (`number`, `string`, `boolean`) — the uppercase variants are JS constructor types, not value types, and most linters flag them.

## Using the CLI to pre-build `swagger.json`

```bash
npx express-swagger <app-module> [options]
```

| Argument / option   | Description                                                                   | Default                                                            |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `<app-module>`      | Path to the module that exports the Express app (or a factory returning one). | _required_                                                         |
| `--export <name>`   | Named export to treat as the app or app factory (falls back to `default`).    | `setupApp`                                                         |
| `--tsconfig <path>` | `tsconfig.json` to use for type extraction.                                   | nearest `tsconfig.json` walking up from the app module's directory |
| `--out <path>`      | Where to write the resulting OpenAPI JSON.                                    | `swagger.json`                                                     |
| `--minify`          | Write JSON on a single line without indentation.                              | indented with two spaces                                           |
| `--help`            | Show usage.                                                                   |                                                                    |

**Example** — produce `public/swagger.json` and serve it as a static file:

```bash
npx express-swagger src/app.js --out public/swagger.json
```

```js
// src/app.js
import express from 'express';
import path from 'node:path';

export function setupApp() {
  const app = express();
  app.use(express.json());
  // ...annotated routes...
  app.use(express.static(path.resolve('public')));
  return app;
}
```

The static middleware then serves the pre-built doc at `/swagger.json` — no runtime type compilation cost.

### Loading the generated `swagger.json` from your app

If you want to inline the doc into a handler (e.g. to feed Swagger UI / Scalar from the same process that serves the API), prefer dynamic `await import(...)` over a static top-of-module import:

```js
// src/routes/swagger.js — recommended
import { Router } from 'express';

export function swaggerRouter() {
  const router = Router();
  router.get('/swagger.json', async (_req, res) => {
    const { default: doc } = await import('../../public/swagger.json', { with: { type: 'json' } });
    res.json(doc);
  });
  return router;
}
```

Why dynamic import: a static `import doc from '../../public/swagger.json' with { type: 'json' }` is evaluated when the module is **loaded**, which is also when the CLI imports your app to walk its routes. If the JSON file doesn't exist yet (first build, CI cold cache, etc.) the static import fails before the CLI gets a chance to write it. The CLI does pre-create an empty placeholder to keep this case from breaking, but the loaded value is then stale `{}` until the process is restarted.

`await import(...)` evaluates per-request, so each call reads whatever the on-disk file says — including the doc the CLI just wrote. Same applies to `JSON.parse(await readFile(path, 'utf8'))` if you want explicit FS semantics.

If you'd rather use a plain static import:

```js
import doc from '../../public/swagger.json' with { type: 'json' };
```

…that's fine — just **commit `public/swagger.json` to the repo**. Then the file is guaranteed to exist at module-load time, both for the CLI's own walk and for `node` starting the server. Re-running the CLI overwrites the file in place, so the next server start picks up changes. This is the simplest pattern when the doc only changes alongside source changes (i.e., it's already part of code review).

## Writing your own pre-build script

For more control than the CLI offers — multiple apps, custom doc shaping, pipeline integration — call `buildSwaggerDocument` directly:

```javascript
// build-swagger.js — wired against the example app that ships with this repo
import { writeFile } from 'node:fs/promises';
import { buildSwaggerDocument } from '@aller/express-swagger';
import { setupApp } from './example/index.js';

const doc = await buildSwaggerDocument(setupApp(), {
  tsconfig: new URL('./example/tsconfig.json', import.meta.url),
});

await writeFile('./example/public/swagger.json', JSON.stringify(doc, null, 2));
```

`buildSwaggerDocument(app, options)`:

- `app` — an Express app with routes already registered.
- `options.tsconfig` — `string | URL` pointing at a `tsconfig.json`. Optional; when omitted, the document ships without a `components.schemas` section and request / response bodies fall back to `{ type: 'object' }` stubs.
- `options.security` — `Record<string, OpenAPISecurityScheme>` to declare under `components.securitySchemes`. Each handler tagged with `@security <name>` references one of these keys. Conventional names — `bearerAuth` (`{ type: 'http', scheme: 'bearer' }`) and `basicAuth` (`{ type: 'http', scheme: 'basic' }`) — auto-emit a default scheme when referenced without an explicit declaration; explicit `options.security` entries always override the defaults.
- `info.title` is read from the nearest `package.json` `description` (walking up from the tsconfig's directory), falling back to `"API"`. `info.version` defaults to `"0.0.0"`.
- Returns `Promise<OpenAPIDocument>`.

### Security example

Schemes can be declared explicitly via `options.security`, or, for the conventional names below, auto-emitted from the JSDoc itself:

| `@security` form                                 | Auto-emitted scheme                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `@security bearerAuth`                           | `{ type: 'http', scheme: 'bearer' }`                                            |
| `@security basicAuth`                            | `{ type: 'http', scheme: 'basic' }`                                             |
| `@security apiKey <header-name>`                 | `{ type: 'apiKey', in: 'header', name: '<header-name>' }`                       |
| `@security openIdConnect <issuer-url> [scope …]` | `{ type: 'openIdConnect', openIdConnectUrl: '<issuer-url>' }` (scopes optional) |

Explicit `options.security` always wins. Custom names that don't match an auto-default must be declared in `options.security`.

**Explicit declaration:**

```js
const doc = await buildSwaggerDocument(app, {
  tsconfig,
  security: {
    bearer: { type: 'http', scheme: 'bearer' },
  },
});

app.get(
  '/me',
  /**
   * @param {import('express').Request} _req
   * @param {import('express').Response<UserRecord>} res
   * @security bearer
   */
  (_req, res) => res.json(currentUser)
);
```

**Auto-emitted apiKey via the `@security apiKey <header>` shorthand** — no `options.security` entry needed:

```js
app.get(
  '/users',
  /**
   * @param {import('express').Request} _req
   * @param {import('express').Response<UserRecord[]>} res
   * @security apiKey x-my-key-header
   */
  (_req, res) => res.json(users)
);
```

The above auto-registers `components.securitySchemes.apiKey = { type: 'apiKey', in: 'header', name: 'x-my-key-header' }` on the document and adds `security: [{ apiKey: [] }]` to the operation. Other operations can reference the same scheme by writing the bare `@security apiKey` (no header arg) — the first occurrence to provide a header name wins.

**Auto-emitted OpenID Connect via `@security openIdConnect <issuer-url> [scope …]`:**

```js
app.get(
  '/me',
  /**
   * @param {import('express').Request} _req
   * @param {import('express').Response<UserRecord>} res
   * @security openIdConnect https://issuer.example.com/.well-known/openid-configuration openid email
   */
  (_req, res) => res.json(currentUser)
);
```

The issuer URL is detected by its `https?://` prefix, so it's optional — omit it (`@security openIdConnect openid email`) when the scheme is already declared via `options.security` and you only want to attach scopes. With the URL present, the library auto-registers `components.securitySchemes.openIdConnect = { type: 'openIdConnect', openIdConnectUrl: '<url>' }`. Per-op security carries any trailing scope tokens: `security: [{ openIdConnect: ['openid', 'email'] }]`.

## Serving on demand

For dev workflows where you don't want a build step, expose a route that builds the doc each time it's hit:

```js
import { buildSwaggerDocument } from '@aller/express-swagger';

app.get('/swagger/live', async (_req, res) => {
  const doc = await buildSwaggerDocument(app, { tsconfig: TSCONFIG_PATH });
  res.json(doc);
});
```

Each request re-runs the TypeScript compile — fine for local development, not recommended for production traffic.

## Smallest working example

A self-contained smoke test of `buildSwaggerDocument` — instantiate an Express app, register a route, build the doc, and assert on the result. No tsconfig is passed, so the doc ships without `components.schemas` and request/response bodies fall back to `{ type: 'object' }` stubs:

```javascript
import express from 'express';
import { strict as assert } from 'node:assert';

import { buildSwaggerDocument } from '@aller/express-swagger';

const app = express();
app.get('/hello', (_req, res) => res.json({ greeting: 'hi' }));

const doc = await buildSwaggerDocument(app);

assert.equal(doc.openapi, '3.0.0');
assert.ok(doc.paths['/hello'].get.responses['200'], 'expected a 200 response on GET /hello');
```

The block above is executed in CI via [`texample`](https://www.npmjs.com/package/texample) (`npm run example:check`) — any drift in the public API surface trips the assertions.

## Debug

Enable [`debug`](https://www.npmjs.com/package/debug) logging under the namespace `aller-express-swagger`:

```bash
DEBUG=aller-express-swagger npx express-swagger src/app.js
```
