import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createDebug from 'debug';
import ts from 'typescript';

const debug = createDebug('aller-express-swagger');
const warn = debug.extend('warn');
const error = debug.extend('error');

/**
 * Internal helper types referenced from this module's own JSDoc annotations.
 * `@import` brings the names into scope without re-declaring them, so dts-buddy
 * doesn't see the same name declared twice (here and in `types/types.d.ts`)
 * and rename the underlying interface to `Foo_1` in the bundled output. The
 * user-facing response/body types (`ApiResponse`, `Binary`, `MultipartBody`,
 * etc.) aren't referenced in this file at all — they're re-exported from
 * `types/bundle.d.ts`, which is the dts-buddy bundle entry.
 *
 * @import { ThrowsEntry, SlotInfo, RouteMetadata, SecurityRequirement, LoadedTsconfig } from 'types'
 */

/**
 * @import {
 *   Identifier,
 *   JSDocTag,
 *   Program,
 *   SourceFile,
 *   Symbol as TsSymbol,
 *   TypeChecker,
 * } from 'typescript'
 */

const BODY_METHODS = new Set(['post', 'put', 'patch']);

/**
 * JSDoc tags that hide a handler from the OpenAPI document. Any one of these
 * — bare, no value needed — is enough to drop the route entirely.
 */
const HIDE_TAGS = ['private', 'ignore', 'protected', 'internal'];

/**
 * Conventional `@security` names that auto-emit a sensible
 * `components.securitySchemes` entry when no explicit `options.security`
 * declaration is provided. Users can override any of these by passing the
 * same key in `options.security`.
 *
 * @type {Record<string, Record<string, any>>}
 */
const DEFAULT_SECURITY_SCHEMES = {
  bearerAuth: { type: 'http', scheme: 'bearer' },
  basicAuth: { type: 'http', scheme: 'basic' },
};

/**
 * Build the OpenAPI document for an Express app. Callers choose how to serve
 * it — e.g. write it to disk and expose via `express.static`, or wrap in a
 * route handler for on-demand delivery.
 *
 * @param {import('express').Express} app
 * @param {{ tsconfig?: string | URL, security?: Record<string, any> }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function buildSwaggerDocument(app, options = {}) {
  debug('building OpenAPI document (tsconfig=%s)', options.tsconfig ?? '<none>');
  const securitySchemes = options.security ?? null;
  const loaded = options.tsconfig
    ? await loadFromTsconfig(options.tsconfig)
    : /** @type {LoadedTsconfig} */ ({
        schemas: {},
        jsdocThrows: new Map(),
        usePrefixes: [],
        privateRoutes: new Set(),
        descriptions: new Map(),
        statusByType: new Map(),
        handlerTypes: new Map(),
        tags: new Map(),
        deprecations: new Map(),
        security: new Map(),
        requestExamples: new Map(),
        title: null,
        version: null,
      });
  const doc = buildDocument(
    app,
    loaded.schemas,
    loaded.jsdocThrows,
    loaded.usePrefixes,
    loaded.privateRoutes,
    loaded.descriptions,
    loaded.statusByType,
    loaded.handlerTypes,
    loaded.tags,
    loaded.deprecations,
    loaded.security,
    loaded.requestExamples,
    securitySchemes,
    loaded.title,
    loaded.version
  );
  const schemas = /** @type {Record<string, unknown> | undefined} */ (doc.components)?.schemas ?? {};
  debug('OpenAPI document done — %d paths, %d schemas', Object.keys(doc.paths).length, Object.keys(schemas).length);
  return doc;
}

/**
 * Build a schema catalog whose entries convert lazily. Each declared name gets
 * a memoizing accessor: `convert(node)` runs only the first time that name is
 * read, and the result is cached for later reads. Names no consumer reaches are
 * never converted — so a project pays nothing for unreferenced types, and a
 * large unreferenced type graph is never walked. Accessors are non-enumerable:
 * reads are by explicit key, so enumerating or spreading the catalog must not
 * force every type to materialize.
 *
 * Exported for unit testing; not part of the public API (public types come from
 * the hand-written `types/bundle.d.ts`).
 *
 * @param {Array<{ name: string, node: any }>} declarations
 * @param {(node: any) => object} convert
 * @returns {Record<string, object>}
 */
export function createLazySchemaCatalog(declarations, convert) {
  /** @type {Record<string, object>} */
  const catalog = Object.create(null);
  /** @type {Record<string, object>} */
  const cache = Object.create(null);
  for (const { name, node } of declarations) {
    Object.defineProperty(catalog, name, {
      configurable: true,
      get() {
        if (name in cache) return cache[name];
        const schema = convert(node);
        cache[name] = schema;
        return schema;
      },
    });
  }
  return catalog;
}

/**
 * Build JSON Schemas for each exported interface / type alias in the given
 * tsconfig's `.d.ts` files, and collect `@throws` JSDoc tags from each
 * `app.<method>(<path>, …)` handler in the program. Both flow into the
 * generated OpenAPI document.
 *
 * @param {string | URL} tsconfigRef
 * @returns {Promise<LoadedTsconfig>}
 */
async function loadFromTsconfig(tsconfigRef) {
  // The TypeScript 7 native port drops the classic `ts.sys` compiler host this
  // module relies on to read the tsconfig and enumerate source files. Without
  // it every access below is a cryptic `Cannot read properties of undefined`;
  // fail fast with a message that names the real cause and supported range.
  /* c8 ignore start -- guard for the unsupported TS 7 native port; unreachable with a peer-compatible TypeScript, which always exposes ts.sys. */
  if (!ts.sys) {
    const message = `express-swagger requires the classic TypeScript compiler host (ts.sys), which TypeScript ${
      ts.version ?? '<unknown>'
    } does not provide. Install a supported TypeScript (>=5 <7) — the native TypeScript 7 port is not yet supported.`;
    error('%s', message);
    throw new Error(message);
  }
  /* c8 ignore stop */

  const tsconfigPath = tsconfigRef instanceof URL ? fileURLToPath(tsconfigRef) : path.resolve(tsconfigRef);
  const configDir = path.dirname(tsconfigPath);

  const configRead = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configRead.error) {
    const message = ts.flattenDiagnosticMessageText(configRead.error.messageText, '\n');
    error('tsconfig read failed at %s: %s', tsconfigPath, message);
    throw new Error(message);
  }

  const parsed = ts.parseJsonConfigFileContent(configRead.config, ts.sys, configDir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  /** @type {Set<string>} */
  const knownNames = new Set();
  /** @type {Array<{ name: string, node: any }>} */
  const declarations = [];

  // `.d.ts` first: their interface/type declarations take precedence over
  // JSDoc `@typedef` re-exports that just alias back to them. Iterate every
  // program file (not just `include` matches) so types reached only through
  // `compilerOptions.paths` still contribute schemas.
  const orderedFiles = program
    .getSourceFiles()
    .filter((/** @type {any} */ sf) => !sf.isDefaultLibrary)
    .filter((/** @type {any} */ sf) => !sf.fileName.includes('/node_modules/'))
    .map((/** @type {any} */ sf) => sf.fileName)
    .sort((/** @type {string} */ a, /** @type {string} */ b) => {
      const aDts = a.endsWith('.d.ts');
      const bDts = b.endsWith('.d.ts');
      if (aDts && !bDts) return -1;
      if (!aDts && bDts) return 1;
      return 0;
    });

  for (const fileName of orderedFiles) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;

    const isDts = fileName.endsWith('.d.ts');
    const isTs = !isDts && /\.(?:m|c)?ts$/.test(fileName);

    if (isDts || isTs) {
      for (const statement of sourceFile.statements) {
        if (ts.isExportDeclaration(statement)) {
          for (const { name, node } of reExportedTypeDeclarations(statement, checker, ts)) {
            if (knownNames.has(name)) continue;
            knownNames.add(name);
            declarations.push({ name, node });
          }
          continue;
        }
        if (!isExported(statement, ts)) continue;
        if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEnumDeclaration(statement)) continue;
        const name = statement.name.text;
        if (knownNames.has(name)) continue;
        knownNames.add(name);
        declarations.push({ name, node: statement });
      }
    }

    if (!isDts) {
      for (const tag of findJsDocTypedefs(sourceFile, ts)) {
        const name = tag.name?.text;
        if (!name || knownNames.has(name)) continue;
        knownNames.add(name);
        declarations.push({ name, node: tag });
      }
    }
  }

  // Lazy schema catalog: the expensive `typeToSchema` walk runs only when a
  // name is actually read — during the route walk (referenced slots) or the
  // reachability prune. Types no route reaches are never converted, so an app
  // pays nothing for unrelated typedefs (a large unreferenced metamodel would
  // otherwise be walked in full for no output).
  const schemas = createLazySchemaCatalog(declarations, (node) => {
    if (ts.isEnumDeclaration(node)) {
      // `.d.ts` enum members without initializers report no TypeChecker value
      // (flags: Enum, value: undefined) — build from the AST so we can fall
      // back to member names instead of auto-assigned indices.
      return enumDeclarationToSchema(node, ts);
    }
    const anchor = ts.isJSDocTypedefTag(node) ? node.name : node;
    const type = checker.getTypeAtLocation(anchor);
    const schema = typeToSchema(type, checker, ts, knownNames);
    mergeMappedHeritageProperties(schema, node, ts, checker, knownNames);
    return schema;
  });

  // Status inference is cheap AST work (it does not resolve the property
  // graph), so it stays eager — no need to defer it with the schema conversion.
  /** @type {Map<string, string>} */
  const statusByType = new Map();
  for (const { name, node } of declarations) {
    const status = inferStatusFromType(node, ts, checker);
    if (status) statusByType.set(name, status);
  }

  const { jsdocThrows, privateRoutes, descriptions, handlerTypes, tags, deprecations, security, requestExamples } = collectRouteMetadata(
    program,
    ts,
    checker
  );
  resolveInlineThrows(jsdocThrows, checker, ts, knownNames);
  resolveInlineHandlerSlots(handlerTypes, checker, ts, knownNames);
  const usePrefixes = collectUsePrefixes(program, ts);
  const { description: title, version } = await readNearestPackageInfo(configDir);
  return {
    schemas,
    jsdocThrows,
    usePrefixes,
    privateRoutes,
    descriptions,
    statusByType,
    handlerTypes,
    tags,
    deprecations,
    security,
    requestExamples,
    title,
    version,
  };
}

/**
 * Walk up from `startDir` looking for the nearest readable `package.json` and
 * return its `description` and `version` fields. Used to populate `info.title`
 * and `info.version` on the emitted OpenAPI document.
 *
 * @param {string} startDir
 * @returns {Promise<{ description: string | null, version: string | null }>}
 */
async function readNearestPackageInfo(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, 'package.json');
    try {
      const raw = await readFile(candidate, 'utf8');
      const pkg = JSON.parse(raw);
      const description = typeof pkg.description === 'string' && pkg.description.length > 0 ? pkg.description : null;
      const version = typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null;
      if (description || version) return { description, version };
    } catch {
      /* Missing or malformed — keep searching the parent. */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { description: null, version: null };
    dir = parent;
  }
}

/**
 * Collect every string-prefixed `app.use('/prefix', …)` call from the program.
 * The list is used at runtime to recover the mount path of nested routers,
 * since Express 5's Layer doesn't expose it directly.
 *
 * @param {Program} program
 * @param {typeof import('typescript')} ts
 * @returns {string[]}
 */
function collectUsePrefixes(program, ts) {
  /** @type {string[]} */
  const prefixes = [];

  /** @param {any} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'app' &&
        callee.name.text === 'use'
      ) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteralLike(firstArg)) {
          prefixes.push(firstArg.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    visit(sourceFile);
  }
  return prefixes;
}

/**
 * Walk every non-declaration source file in the program. For each
 * `<receiver>.<method>(<path>, …)` call that looks like an Express route
 * registration, find the handler function and harvest every metadata signal
 * available from its JSDoc:
 *   - `@throws {T}` tags
 *   - `@private` flag
 *   - free-text description
 *   - request/response/path-params/query type names (from `@param` generics)
 *
 * @param {Program} program
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {{ jsdocThrows: Map<string, ThrowsEntry[]>, privateRoutes: Set<string>, descriptions: Map<string, string>, handlerTypes: Map<string, RouteMetadata>, tags: Map<string, string[]>, deprecations: Map<string, string>, security: Map<string, SecurityRequirement[]>, requestExamples: Map<string, { value: unknown }> }}
 */
function collectRouteMetadata(program, ts, checker) {
  /** @type {Map<string, ThrowsEntry[]>} */
  const jsdocThrows = new Map();
  /** @type {Set<string>} */
  const privateRoutes = new Set();
  /** @type {Map<string, string>} */
  const descriptions = new Map();
  /** @type {Map<string, RouteMetadata>} */
  const handlerTypes = new Map();
  /** @type {Map<string, string[]>} */
  const tags = new Map();
  /** @type {Map<string, string>} */
  const deprecations = new Map();
  /** @type {Map<string, SecurityRequirement[]>} */
  const security = new Map();
  /** @type {Map<string, { value: unknown }>} */
  const requestExamples = new Map();

  /** @param {any} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const route = matchRouteCall(node, ts, checker);
      if (route) {
        const handlerFn = findHandlerFunction(node.arguments, ts, checker);
        // For higher-order calls (`apiReference(…)`, factories) handlerFn is
        // null — fall back so JSDoc on the route statement still applies.
        const jsDocSource = handlerFn ?? node.arguments[node.arguments.length - 1] ?? node;
        const entries = extractJsDocThrows(jsDocSource, ts);
        const isPrivate = HIDE_TAGS.some((tag) => hasJsDocTag(jsDocSource, tag));
        const description = extractJsDocDescription(jsDocSource, ts);
        const metadata =
          (handlerFn ? parseHandlerTypes(handlerFn, ts, checker) : null) ?? parseHandlerTypesFromFactory(node.arguments, ts, checker);
        const tagList = extractJsDocTagList(jsDocSource, ts);
        const deprecationMessage = extractDeprecation(jsDocSource, ts);
        const securityList = extractJsDocSecurity(jsDocSource, ts);
        const requestExample = extractJsDocExample(jsDocSource, ts);
        for (const path of route.paths) {
          const key = `${route.method} ${path}`;
          if (entries.length > 0) jsdocThrows.set(key, entries);
          if (isPrivate) privateRoutes.add(key);
          if (description) descriptions.set(key, description);
          if (metadata) handlerTypes.set(key, metadata);
          if (tagList.length > 0) tags.set(key, tagList);
          if (deprecationMessage !== null) deprecations.set(key, deprecationMessage);
          if (securityList.length > 0) security.set(key, securityList);
          if (requestExample) requestExamples.set(key, requestExample);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    visit(sourceFile);
  }

  return { jsdocThrows, privateRoutes, descriptions, handlerTypes, tags, deprecations, security, requestExamples };
}

/**
 * Parse the request handler's `@param` tags for `Request<P, ResBody, ReqBody,
 * Query>` and `Response<Body>` generics. Also recognizes `@type
 * {RequestHandler<P, ResBody, ReqBody, Query>}` on the function itself —
 * Express's handler signature pins all four slot types in one place, so a
 * function annotated this way doesn't need per-parameter `@param` tags.
 * Returns `null` when nothing was extractable. Only named-identifier generic
 * arguments produce metadata — an inline `{}` or a keyword like `unknown` is
 * ignored.
 *
 * @param {any} fn
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {RouteMetadata | null}
 */
function parseHandlerTypes(fn, ts, checker) {
  /** @type {RouteMetadata} */
  const out = {};
  for (const tag of getDirectJsDocTags(fn)) {
    // `@type {RequestHandler<…>}` on the function itself (or the surrounding
    // VariableStatement for a `const handler = …` declaration), and `@returns
    // {RequestHandler<…>}` on a higher-order factory function that produces
    // the handler. Both pin the four slot types in one place; the library
    // treats them like a `@param {Request<…>} req` tag.
    if (tag.tagName?.text === 'type' || tag.tagName?.text === 'returns') {
      const typeNode = tag.typeExpression?.type;
      if (!typeNode) continue;
      const head = resolveRequestHandlerHead(peelHandlerWrappers(typeNode, ts), ts);
      if (!head) continue;
      const [p, resBody, reqBody, query] = head.args;
      if (!out.params) out.params = slotInfoFromTypeNode(p, ts);
      if (!out.response) out.response = slotInfoFromTypeNode(resBody, ts);
      if (!out.request) out.request = slotInfoFromTypeNode(reqBody, ts);
      if (!out.query) out.query = slotInfoFromTypeNode(query, ts);
      continue;
    }
    if (tag.tagName?.text !== 'param') continue;
    const typeNode = tag.typeExpression?.type;
    if (!typeNode) continue;
    const head = resolveGenericHead(typeNode, ts);
    if (!head) continue;
    const description = jsDocTagComment(tag, ts);
    if (head.name === 'Request') {
      const [p, res, req, query] = head.args;
      if (!out.params) out.params = slotInfoFromTypeNode(p, ts);
      if (!out.response) out.response = slotInfoFromTypeNode(res, ts);
      if (!out.request) out.request = slotInfoFromTypeNode(req, ts);
      if (!out.query) out.query = slotInfoFromTypeNode(query, ts);
      if (description && !out.requestDescription) out.requestDescription = description;
    } else if (head.name === 'Response') {
      // Express's `Response<Body, Locals>` — slot 2 is Locals, not a status.
      const [body] = head.args;
      const slot = slotInfoFromTypeNode(body, ts);
      if (slot) out.response = slot;
      if (description) out.responseDescription = description;
    } else if (head.name === 'ApiResponse') {
      // Library `ApiResponse<Body, StatusCode, MediaType>` — slot 2 pins
      // the success status, slot 3 pins the response media type.
      const [body, maybeStatus, maybeMediaType] = head.args;
      const slot = slotInfoFromTypeNode(body, ts);
      if (slot) out.response = slot;
      if (description) out.responseDescription = description;
      if (maybeStatus && ts.isLiteralTypeNode(maybeStatus) && ts.isNumericLiteral(maybeStatus.literal)) {
        out.responseStatus = maybeStatus.literal.text;
      }
      if (maybeMediaType && ts.isLiteralTypeNode(maybeMediaType) && ts.isStringLiteral(maybeMediaType.literal) && out.response) {
        out.response.contentType = maybeMediaType.literal.text;
      }
    } else if (!out.response) {
      // Unrecognized head — treat as a response slot if its type chains to
      // `ApiResponse<…>` (e.g. bare `_res: NoContentResponse` /
      // `CreatedResponse<X>` / a user-side alias). Saves wrapping in a
      // `Response<…>` just to surface the chain status.
      const status = inferStatusFromTypeNode(typeNode, ts, checker);
      if (status) {
        out.response = slotInfoFromTypeNode(typeNode, ts);
        out.responseStatus = status;
        if (description) out.responseDescription = description;
        const resolved = checker.getTypeFromTypeNode(typeNode);
        const chainContentType = walkTypeChainForContentType(resolved, ts, checker, new Set());
        if (chainContentType && out.response) out.response.contentType = chainContentType;
      }
    }
  }
  // Fall back to TypeScript parameter type annotations for any slot the JSDoc
  // tags didn't fill. Lets TS-source consumers write idiomatic
  // `(req: Request<…>, res: Response<…>)` without parallel JSDoc.
  if (fn.parameters) {
    for (const param of fn.parameters) {
      applyParameterTypeAnnotation(out, param.type, ts, checker);
    }
  }
  return out.params || out.request || out.response || out.query ? out : null;
}

/**
 * Read a TypeScript parameter type annotation and fill any still-empty slots
 * of `out`. Mirrors the JSDoc `@param` dispatch in `parseHandlerTypes` but
 * only ever writes when the slot is undefined — JSDoc always wins.
 *
 * @param {RouteMetadata} out
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 */
function applyParameterTypeAnnotation(out, typeNode, ts, checker) {
  if (!typeNode) return;
  const head = resolveGenericHead(typeNode, ts);
  if (head) {
    if (head.name === 'Request') {
      const [p, res, req, query] = head.args;
      if (!out.params) out.params = slotInfoFromTypeNode(p, ts);
      if (!out.response) out.response = slotInfoFromTypeNode(res, ts);
      if (!out.request) out.request = slotInfoFromTypeNode(req, ts);
      if (!out.query) out.query = slotInfoFromTypeNode(query, ts);
      return;
    }
    if (head.name === 'Response') {
      if (!out.response) {
        const [body] = head.args;
        const slot = slotInfoFromTypeNode(body, ts);
        if (slot) out.response = slot;
      }
      return;
    }
    if (head.name === 'ApiResponse') {
      const [body, maybeStatus, maybeMediaType] = head.args;
      if (!out.response) {
        const slot = slotInfoFromTypeNode(body, ts);
        if (slot) out.response = slot;
      }
      if (!out.responseStatus && maybeStatus && ts.isLiteralTypeNode(maybeStatus) && ts.isNumericLiteral(maybeStatus.literal)) {
        out.responseStatus = maybeStatus.literal.text;
      }
      if (
        out.response &&
        !out.response.contentType &&
        maybeMediaType &&
        ts.isLiteralTypeNode(maybeMediaType) &&
        ts.isStringLiteral(maybeMediaType.literal)
      ) {
        out.response.contentType = maybeMediaType.literal.text;
      }
      return;
    }
  }
  if (out.response) return;
  const status = inferStatusFromTypeNode(typeNode, ts, checker);
  if (!status) return;
  out.response = slotInfoFromTypeNode(typeNode, ts);
  out.responseStatus = status;
  const resolved = checker.getTypeFromTypeNode(typeNode);
  const chainContentType = walkTypeChainForContentType(resolved, ts, checker, new Set());
  if (chainContentType && out.response) out.response.contentType = chainContentType;
}

/**
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {SlotInfo | undefined}
 */
function slotInfoFromTypeNode(typeNode, ts) {
  if (!typeNode) return undefined;
  const peeled = peelUtilityWrappers(typeNode, ts);
  const bodyMarker = peelRequestBodyMarker(peeled, ts);
  const finalNode = bodyMarker?.inner ?? peeled;
  const name = identifierFromTypeNode(finalNode, ts);
  /** @type {SlotInfo} */
  const slot = name ? { name, typeNode: finalNode } : { typeNode: finalNode };
  if (bodyMarker) slot.contentType = bodyMarker.contentType;
  return slot;
}

/**
 * Library brand wrappers for non-JSON request bodies. The wrapper carries no
 * runtime/structural shape — `T` is the actual payload schema; the wrapper
 * name only switches the emitted `requestBody` content key. Detection has to
 * cover both the bare `MultipartBody<T>` form and the `import('@aller/express-swagger').MultipartBody<T>`
 * form (via JSDoc inline imports), and must verify the import-type form
 * resolves to the library module so a same-named user type doesn't get
 * coerced.
 *
 * @type {Record<string, string>}
 */
const REQUEST_BODY_MARKERS = {
  FormBody: 'application/x-www-form-urlencoded',
  MultipartBody: 'multipart/form-data',
};

/**
 * Detect a `FormBody<T>` / `MultipartBody<T>` wrapper at the head of a slot's
 * type node. Returns the wire content type and the inner `T` typeNode when
 * matched, or null otherwise. Handles both bare and `import(...)`-qualified
 * forms; the qualified form must resolve to the library module specifier.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {{ contentType: string, inner: any } | null}
 */
function peelRequestBodyMarker(typeNode, ts) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const contentType = REQUEST_BODY_MARKERS[typeNode.typeName.text];
    /* c8 ignore next 3 -- bare-identifier `MultipartBody`/`FormBody` is rare; JSDoc users typically write the `import('@aller/express-swagger').…<T>` form. */
    if (contentType && typeNode.typeArguments?.[0]) {
      return { contentType, inner: typeNode.typeArguments[0] };
    }
  }
  if (ts.isImportTypeNode(typeNode) && typeNode.qualifier && ts.isIdentifier(typeNode.qualifier)) {
    const contentType = REQUEST_BODY_MARKERS[typeNode.qualifier.text];
    if (contentType && typeNode.typeArguments?.[0] && importTypeModuleSpec(typeNode, ts) === '@aller/express-swagger') {
      return { contentType, inner: typeNode.typeArguments[0] };
    }
  }
  return null;
}

/**
 * TS utility wrappers that don't structurally change the resolved shape —
 * `Promise<T>` / `Awaited<T>` / `NonNullable<T>` / `Required<T>` /
 * `Readonly<T>` / `ReturnType<F>` all unwrap to their effective inner type
 * for OpenAPI-schema purposes. Transformations like `Partial`/`Pick`/`Omit`
 * are deliberately excluded since they produce a different shape.
 */
const PEELABLE_UTILITY_WRAPPERS = new Set(['Promise', 'Awaited', 'NonNullable', 'Required', 'Readonly', 'ReturnType']);

/**
 * Walk through nested utility wrappers, taking the first type argument each
 * time, so e.g. `Awaited<Promise<UserRecord>>` peels down to `UserRecord`.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {any}
 */
function peelUtilityWrappers(typeNode, ts) {
  let current = typeNode;
  while (
    current &&
    ts.isTypeReferenceNode(current) &&
    ts.isIdentifier(current.typeName) &&
    PEELABLE_UTILITY_WRAPPERS.has(current.typeName.text) &&
    current.typeArguments?.[0]
  ) {
    current = current.typeArguments[0];
  }
  return current;
}

/**
 * Peel wrappers Express accepts around a handler type — `Promise<…>` /
 * `Awaited<…>` / `…[]` (`ArrayTypeNode`) / `Array<…>` — so a `@type` or
 * `@returns` carrying e.g. `RequestHandler<…>[]` or `Promise<RequestHandler<…>>`
 * still resolves to the inner `RequestHandler` for slot-type extraction.
 * Iterates until none of the recognized wrappers match.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {any}
 */
function peelHandlerWrappers(typeNode, ts) {
  let current = typeNode;
  let prev = null;
  while (current && current !== prev) {
    prev = current;
    current = peelUtilityWrappers(current, ts);
    if (ts.isArrayTypeNode(current)) {
      current = current.elementType;
      continue;
    }
    if (
      ts.isTypeReferenceNode(current) &&
      ts.isIdentifier(current.typeName) &&
      current.typeName.text === 'Array' &&
      current.typeArguments?.[0]
    ) {
      current = current.typeArguments[0];
    }
  }
  return current;
}

/** @type {Record<string, string>} */
const EXPECTED_HEAD_SOURCE = {
  Request: 'express',
  Response: 'express',
  ApiResponse: '@aller/express-swagger',
};

/**
 * Given a type node, recognize `Request<…>` / `Response<…>` whether written as
 * a bare `TypeReferenceNode` or an `ImportTypeNode` (e.g.
 * `import('express').Request<…>`). Returns `{ name, args }` or null.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {{ name: string, args: any[] } | null}
 */
function resolveGenericHead(typeNode, ts) {
  /* c8 ignore next 3 -- bare-identifier `Request<…>` is rare; the fixture exercises the import-type form. */
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return { name: typeNode.typeName.text, args: typeNode.typeArguments ? [...typeNode.typeArguments] : [] };
  }
  if (ts.isImportTypeNode(typeNode) && typeNode.qualifier && ts.isIdentifier(typeNode.qualifier)) {
    const name = typeNode.qualifier.text;
    // Recognized heads must come from their canonical module — a same-named
    // type from elsewhere is not Express metadata.
    const expectedSource = EXPECTED_HEAD_SOURCE[name];
    if (expectedSource) {
      const actualSource = importTypeModuleSpec(typeNode, ts);
      if (actualSource !== expectedSource) {
        warn(
          'ignoring @param {import("%s").%s<…>} at %s: expected import from "%s"',
          actualSource ?? '<unknown>',
          name,
          nodeLocation(typeNode),
          expectedSource
        );
        return null;
      }
    }
    return { name, args: typeNode.typeArguments ? [...typeNode.typeArguments] : [] };
  }
  /* c8 ignore next -- defensive: typeNode is neither a TypeReference nor an ImportType. */
  return null;
}

/**
 * Recognize `RequestHandler<P, ResBody, ReqBody, Query>` (bare or
 * `import('express').RequestHandler<…>`) on the function's `@type` tag and
 * return its type arguments. Returns null when the head doesn't match or
 * doesn't come from `express`.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {{ args: any[] } | null}
 */
function resolveRequestHandlerHead(typeNode, ts) {
  /* c8 ignore next 3 -- bare-identifier `RequestHandler` is rare; JSDoc users typically write the `import('express').RequestHandler<…>` form. */
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName) && typeNode.typeName.text === 'RequestHandler') {
    return { args: typeNode.typeArguments ? [...typeNode.typeArguments] : [] };
  }
  if (
    ts.isImportTypeNode(typeNode) &&
    typeNode.qualifier &&
    ts.isIdentifier(typeNode.qualifier) &&
    typeNode.qualifier.text === 'RequestHandler' &&
    importTypeModuleSpec(typeNode, ts) === 'express'
  ) {
    return { args: typeNode.typeArguments ? [...typeNode.typeArguments] : [] };
  }
  /* c8 ignore next -- defensive: `@type`/`@returns` typeNode isn't a RequestHandler reference. */
  return null;
}

/**
 * Read the module specifier from an `ImportTypeNode` (the string literal
 * inside `import('...')`). Returns null when the argument isn't a plain
 * string literal.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {string | null}
 */
function importTypeModuleSpec(typeNode, ts) {
  const arg = typeNode.argument;
  if (!arg || !ts.isLiteralTypeNode(arg) || !ts.isStringLiteral(arg.literal)) return null;
  return arg.literal.text;
}

/**
 * Format a TypeScript AST node's source location as `file:line:col` (both
 * one-indexed) for debug-log identification. Inside-cwd files render as a
 * short relative path; files outside cwd (including any path that would
 * otherwise back out via `..`) keep their absolute form so log lines stay
 * editor-clickable. Returns `<unknown>` when the node has no source file.
 *
 * @param {any} node
 * @returns {string}
 */
function nodeLocation(node) {
  const sourceFile = node.getSourceFile?.();
  /* c8 ignore next -- defensive: AST nodes always carry a source file in practice. */
  if (!sourceFile) return '<unknown>';
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const relative = path.relative(process.cwd(), sourceFile.fileName);
  const display = !relative || relative.startsWith('..') ? sourceFile.fileName : relative;
  return `${display}:${line + 1}:${character + 1}`;
}

/**
 * Returns the identifier text when `typeNode` is a bare TypeReference to a
 * single-identifier name; otherwise null.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {string | null}
 */
function identifierFromTypeNode(typeNode, ts) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return typeNode.typeName.text;
  }
  if (ts.isImportTypeNode(typeNode) && typeNode.qualifier && ts.isIdentifier(typeNode.qualifier)) {
    return typeNode.qualifier.text;
  }
  return null;
}

/**
 * Normalize CRLF / lone-CR line breaks in extracted JSDoc text to LF.
 * TypeScript preserves the source file's line endings in comment text, so a
 * consumer authoring on Windows would otherwise leak `\r` into the generated
 * document's description fields.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Pull the free-text leading description from a function's JSDoc block
 * (the text before any `@tag`). Returns null when there's no description.
 *
 * @param {any} fn
 * @param {typeof import('typescript')} ts
 * @returns {string | null}
 */
function extractJsDocDescription(fn, ts) {
  const carrier = findJsDocCarrier(fn);
  if (!carrier) return null;
  for (const jsDoc of carrier.jsDoc) {
    const comment = jsDoc.comment;
    if (!comment) continue;
    const text = normalizeLineEndings(typeof comment === 'string' ? comment : ts.displayPartsToString(comment));
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/**
 * @param {any} node
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {{ method: string, paths: string[] } | null}
 */
function matchRouteCall(node, ts, checker) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text.toLowerCase();
  if (!ROUTE_METHODS.has(method)) return null;
  const firstArg = node.arguments[0];
  if (!firstArg) return null;
  if (ts.isArrayLiteralExpression(firstArg)) {
    const paths = [];
    for (const element of firstArg.elements) {
      const resolved = resolveStaticString(element, ts, checker);
      if (resolved === null) return null;
      paths.push(resolved);
    }
    return paths.length > 0 ? { method, paths } : null;
  }
  const path = resolveStaticString(firstArg, ts, checker);
  if (path === null) return null;
  return { method, paths: [path] };
}

/**
 * Best-effort static evaluation of a path expression. Handles string literals,
 * template literals (with recursive interpolation), `+` string concatenation,
 * and identifiers bound to any of the above via a `const`/`let` declaration.
 * Returns `null` when the value can't be resolved.
 *
 * @param {any} node
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {string | null}
 */
function resolveStaticString(node, ts, checker) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const piece = resolveStaticString(span.expression, ts, checker);
      if (piece === null) return null;
      out += piece + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticString(node.left, ts, checker);
    if (left === null) return null;
    const right = resolveStaticString(node.right, ts, checker);
    if (right === null) return null;
    return left + right;
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    // Static evaluation can't know whether LHS is truthy/non-nullish at
    // runtime — try LHS first; if it doesn't resolve (e.g. `options?.x`),
    // use the RHS literal as the documented default. Covers the common
    // `options?.basePath || '/fallback'` pattern.
    const left = resolveStaticString(node.left, ts, checker);
    if (left !== null) return left;
    return resolveStaticString(node.right, ts, checker);
  }
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return resolveStaticString(decl.initializer, ts, checker);
    }
  }
  return null;
}

/**
 * @param {any} fn
 * @param {string} name
 * @returns {boolean}
 */
function hasJsDocTag(fn, name) {
  return getDirectJsDocTags(fn).some((/** @type {any} */ tag) => tag.tagName?.text === name);
}

/**
 * Collect all `@tag <name>` JSDoc entries on a handler in declaration order.
 * Each `@tag` line contributes one entry (so multiple tags = multiple lines).
 *
 * @param {any} fn
 * @param {typeof import('typescript')} ts
 * @returns {string[]}
 */
function extractJsDocTagList(fn, ts) {
  const out = [];
  for (const tag of getDirectJsDocTags(fn)) {
    if (tag.tagName?.text !== 'tag') continue;
    const comment = tag.comment;
    if (!comment) continue;
    const text = normalizeLineEndings(typeof comment === 'string' ? comment : ts.displayPartsToString(comment));
    const trimmed = text.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Read a handler's first `@example` JSDoc tag and parse its body as JSON.
 * Accepts three formatting variants for the body:
 *   - bare JSON (`@example { "x": 1 }` or a multi-line block)
 *   - triple-backtick fenced, with or without a language tag (` ```json … ``` `)
 *   - single-backtick inline (`` @example `{ "x": 1 }` ``)
 * Returns `{ value }` wrapped (so legitimate `null` / `false` is distinguishable
 * from "no tag"); returns null when the tag is missing or the body isn't valid
 * JSON. Malformed JSON is silently dropped — same posture as `@default`.
 *
 * @param {any} fn
 * @param {typeof import('typescript')} ts
 * @returns {{ value: unknown } | null}
 */
function extractJsDocExample(fn, ts) {
  for (const tag of getDirectJsDocTags(fn)) {
    if (tag.tagName?.text !== 'example') continue;
    const comment = tag.comment;
    if (!comment) return null;
    const raw = normalizeLineEndings(typeof comment === 'string' ? comment : ts.displayPartsToString(comment)).trim();
    if (!raw) return null;
    const unfenced = stripCodeFence(raw);
    try {
      return { value: JSON.parse(unfenced) };
    } catch (err) {
      warn('ignoring @example at %s: %s', nodeLocation(tag), /** @type {Error} */ (err).message);
      return null;
    }
  }
  return null;
}

/**
 * Peel an optional Markdown-style code fence around a JSON body:
 *   - triple-backtick with an optional language tag — strips both fences
 *   - single-backtick on a one-liner — strips the wrapping backticks
 *   - bare — returned as-is
 *
 * @param {string} body
 * @returns {string}
 */
function stripCodeFence(body) {
  const triple = body.match(/^```[^\n`]*\n([\s\S]*?)\n```$/);
  if (triple) return triple[1].trim();
  const single = body.match(/^`([^`\n]*)`$/);
  if (single) return single[1].trim();
  return body;
}

/**
 * Collect all `@security <scheme> [arg …]` JSDoc entries on a handler in
 * declaration order. The first whitespace-separated token names a declared
 * `securitySchemes` key. Subsequent tokens are interpreted by scheme:
 *   - `apiKey <header-name>` — second token is the request header name; the
 *     library auto-emits `{ type: 'apiKey', in: 'header', name: <header> }`
 *     when no explicit `options.security.apiKey` overrides it.
 *   - `openIdConnect [<issuer-url>] [scope …]` — when the second token starts
 *     with `http://` / `https://` it's the OIDC issuer URL (auto-emits
 *     `{ type: 'openIdConnect', openIdConnectUrl }`); otherwise all remaining
 *     tokens are scopes.
 *   - any other scheme — remaining tokens become OAuth2/OIDC scopes.
 * Each entry emits one `{ <scheme>: [<scopes>] }` requirement on the
 * operation's `security` array, which OpenAPI treats as an OR list of
 * alternatives.
 *
 * @param {any} fn
 * @param {typeof import('typescript')} ts
 * @returns {Array<{ name: string, scopes: string[], headerName?: string, openIdConnectUrl?: string }>}
 */
function extractJsDocSecurity(fn, ts) {
  /** @type {Array<{ name: string, scopes: string[], headerName?: string, openIdConnectUrl?: string }>} */
  const out = [];
  for (const tag of getDirectJsDocTags(fn)) {
    if (tag.tagName?.text !== 'security') continue;
    const comment = tag.comment;
    if (!comment) continue;
    const text = typeof comment === 'string' ? comment : ts.displayPartsToString(comment);
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const [name, ...rest] = tokens;
    if (name === 'apiKey') {
      const [headerName, ...scopes] = rest;
      out.push({ name, scopes, headerName });
    } else if (name === 'openIdConnect' && rest[0] && /^https?:\/\//i.test(rest[0])) {
      const [openIdConnectUrl, ...scopes] = rest;
      out.push({ name, scopes, openIdConnectUrl });
    } else {
      out.push({ name, scopes: rest });
    }
  }
  return out;
}

/**
 * Combine an operation's free-text description with the message from
 * `@deprecated <message>`. The deprecation message is rendered as a markdown
 * `**Deprecated:** …` paragraph so doc UIs that render markdown highlight it.
 * Bare `@deprecated` (no message) emits only the `deprecated: true` flag and
 * does not touch the description.
 *
 * @param {string | undefined} description
 * @param {string | null} deprecationMessage
 * @returns {string | null}
 */
function composeDescription(description, deprecationMessage) {
  const base = description ?? '';
  if (deprecationMessage) {
    const note = `**Deprecated:** ${deprecationMessage}`;
    return base ? `${base}\n\n${note}` : note;
  }
  return base || null;
}

/**
 * Inspect a handler's JSDoc for an `@deprecated` tag. Returns null when the
 * tag is absent, an empty string when present without a message, or the
 * trimmed message text when present with one.
 *
 * @param {any} fn
 * @param {typeof import('typescript')} ts
 * @returns {string | null}
 */
function extractDeprecation(fn, ts) {
  for (const tag of getDirectJsDocTags(fn)) {
    if (tag.tagName?.text !== 'deprecated') continue;
    const comment = tag.comment;
    if (!comment) return '';
    const text = normalizeLineEndings(typeof comment === 'string' ? comment : ts.displayPartsToString(comment));
    return text.trim();
  }
  return null;
}

/**
 * Return the JSDoc tags directly attached to `node.jsDoc`. Unlike
 * `ts.getJSDocTags`, this works reliably for tags on ArrowFunction and
 * FunctionExpression nodes used as call arguments.
 *
 * @param {any} node
 * @returns {any[]}
 */
function getDirectJsDocTags(node) {
  const carrier = findJsDocCarrier(node);
  if (!carrier) return [];
  return carrier.jsDoc.flatMap((/** @type {any} */ doc) => doc.tags ?? []);
}

/**
 * Walk up `node`'s ancestors looking for the nearest node that owns a jsDoc
 * block. For inline `ArrowFunction` / `FunctionExpression` call arguments the
 * carrier is the node itself. For a `const fn = () => {}` declaration the
 * jsDoc lives on the enclosing `VariableStatement` (ArrowFunction →
 * VariableDeclaration → VariableDeclarationList → VariableStatement). For a
 * `function fn() {}` declaration the carrier is the declaration itself.
 *
 * @param {any} node
 * @returns {any | null}
 */
function findJsDocCarrier(node) {
  let current = node;
  for (let i = 0; i < 4 && current; i++) {
    if (Array.isArray(current.jsDoc) && current.jsDoc.length > 0) return current;
    current = current.parent;
  }
  return null;
}

/**
 * When a route's handler argument is `factory(...)` — a CallExpression whose
 * callee resolves to a function with `@returns {RequestHandler<P, R, B, Q>}`
 * — read the four slot types off the factory's `@returns`. Common Express
 * pattern for dependency-injection wrappers (`app.get('/x', makeHandler(deps))`).
 * Returns null when no arg is a factory call or the factory's `@returns` isn't
 * a RequestHandler. The caller still uses the original route statement as the
 * jsDoc source for description / throws / tags / etc., so a third-party
 * factory's unrelated JSDoc doesn't leak into the route description.
 *
 * @param {ArrayLike<any>} args
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {RouteMetadata | null}
 */
function parseHandlerTypesFromFactory(args, ts, checker) {
  for (let i = args.length - 1; i >= 0; i--) {
    let arg = args[i];
    while (arg && ts.isParenthesizedExpression(arg)) arg = arg.expression;
    if (arg && ts.isSpreadElement(arg)) arg = arg.expression;
    if (!ts.isCallExpression(arg)) continue;
    const callee = arg.expression;
    /** @type {any | null} */
    let factory = null;
    if (ts.isIdentifier(callee)) {
      factory = resolveIdentifierToHandler(callee, ts, checker);
    } else if (ts.isPropertyAccessExpression(callee)) {
      factory = resolvePropertyAccessToHandler(callee, ts, checker);
    }
    if (!factory) continue;
    const metadata = parseHandlerTypes(factory, ts, checker);
    if (metadata) return metadata;
  }
  return null;
}

/**
 * @param {ArrayLike<any>} args
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {any | null}
 */
function findHandlerFunction(args, ts, checker) {
  for (let i = args.length - 1; i >= 0; i--) {
    let arg = args[i];
    // Strip JSDoc-cast parentheses: `/** @type {RequestHandler} */ (myHandler)`.
    while (arg && ts.isParenthesizedExpression(arg)) arg = arg.expression;
    // Spread arrays of handlers: `app.METHOD(path, ...middleware)`.
    if (arg && ts.isSpreadElement(arg)) arg = arg.expression;
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return arg;
    if (ts.isCallExpression(arg)) {
      // `<expr>.bind(thisArg, …)` — recurse into the bound expression.
      if (ts.isPropertyAccessExpression(arg.expression) && arg.expression.name.text === 'bind') {
        const bound = arg.expression.expression;
        if (ts.isIdentifier(bound)) {
          const resolved = resolveIdentifierToHandler(bound, ts, checker);
          if (resolved) return resolved;
        } else if (ts.isPropertyAccessExpression(bound)) {
          const resolved = resolvePropertyAccessToHandler(bound, ts, checker);
          if (resolved) return resolved;
        }
      }
      for (const sub of arg.arguments) {
        if (ts.isArrowFunction(sub) || ts.isFunctionExpression(sub)) return sub;
        if (ts.isIdentifier(sub)) {
          const resolved = resolveIdentifierToHandler(sub, ts, checker);
          if (resolved) return resolved;
        }
      }
    }
    if (ts.isIdentifier(arg)) {
      const resolved = resolveIdentifierToHandler(arg, ts, checker);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Resolve a handler identifier (e.g. `app.get('/foo', myHandler)`) to the
 * function node carrying its JSDoc. Returns the FunctionDeclaration itself or
 * the ArrowFunction / FunctionExpression initializer of a VariableDeclaration.
 *
 * @param {Identifier} identifier
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {any | null}
 */
function resolveIdentifierToHandler(identifier, ts, checker) {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return null;
  // `import { foo } from '…'` returns the alias symbol whose declaration is
  // an ImportSpecifier — follow through to the original FunctionDeclaration.
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return handlerFromSymbol(symbol, ts);
}

/**
 * Resolve `obj.method` (a `PropertyAccessExpression`) to the underlying
 * function-like declaration — used when a handler is registered via
 * `instance.method.bind(instance)`. Walks the rightmost name's symbol to
 * its method/function/property declaration.
 *
 * @param {any} propAccess
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {any | null}
 */
function resolvePropertyAccessToHandler(propAccess, ts, checker) {
  const symbol = checker.getSymbolAtLocation(propAccess.name);
  if (!symbol) return null;
  return handlerFromSymbol(symbol, ts);
}

/**
 * Pick the function-like declaration off a symbol. Recognized forms:
 * `FunctionDeclaration`, `MethodDeclaration`, and a `Variable`/`Property`
 * declaration whose initializer is an arrow function or function expression.
 *
 * @param {TsSymbol} symbol
 * @param {typeof import('typescript')} ts
 * @returns {any | null}
 */
function handlerFromSymbol(symbol, ts) {
  for (const decl of symbol.declarations ?? []) {
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) return decl;
    if ((ts.isVariableDeclaration(decl) || ts.isPropertyDeclaration(decl)) && decl.initializer) {
      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
      // Express also accepts a middleware array (`const m = [h1, h2]`).
      // Return the declaration itself so its JSDoc carrier (the surrounding
      // VariableStatement / PropertyDeclaration) is reachable for `@type`-
      // driven slot-type extraction.
      if (ts.isArrayLiteralExpression(init)) return decl;
    }
    // JS-mode prototype assignment: `Class.prototype.method = function () {}`.
    // The symbol's declaration is the LHS PropertyAccessExpression — climb to
    // the surrounding `=` BinaryExpression and read its RHS function.
    if (
      ts.isPropertyAccessExpression(decl) &&
      decl.parent &&
      ts.isBinaryExpression(decl.parent) &&
      decl.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const init = decl.parent.right;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    }
  }
  /* c8 ignore next -- symbol resolves but doesn't point at a function-like declaration. */
  return null;
}

/**
 * @param {any} fn
 * @param {typeof import('typescript')} ts
 * @returns {ThrowsEntry[]}
 */
function extractJsDocThrows(fn, ts) {
  /** @type {ThrowsEntry[]} */
  const out = [];
  for (const tag of getDirectJsDocTags(fn)) {
    if (tag.tagName?.text !== 'throws') continue;
    const typeNode = tag.typeExpression?.type;
    if (!typeNode) continue;
    const entry = parseThrowsTypeNode(typeNode, ts);
    if (!entry) continue;
    const description = jsDocTagComment(tag, ts);
    if (description) entry.description = description;
    out.push(entry);
  }
  return out;
}

/**
 * Pull the trimmed comment text from a JSDoc tag (the free-text after the
 * `{type}`). Handles both string-shaped and SymbolDisplayPart-array-shaped
 * comments emitted by different TypeScript versions.
 *
 * @param {JSDocTag} tag
 * @param {typeof import('typescript')} ts
 * @returns {string | null}
 */
function jsDocTagComment(tag, ts) {
  const comment = tag.comment;
  if (!comment) return null;
  const text = normalizeLineEndings(typeof comment === 'string' ? comment : ts.displayPartsToString(/** @type {any} */ (comment)));
  const trimmed = text.trim();
  return trimmed || null;
}

/**
 * Parse a JSDoc `@throws {…}` type expression into a `{ name }` entry. Only
 * single-identifier references are accepted — the named type must be a
 * resolved schema in the program (checked downstream). Generic instantiations
 * aren't expanded here; point `@throws` at a resolved type alias instead.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {ThrowsEntry | null}
 */
function parseThrowsTypeNode(typeNode, ts) {
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return { name: typeNode.typeName.text, typeNode };
  }
  if (ts.isImportTypeNode(typeNode) && typeNode.qualifier && ts.isIdentifier(typeNode.qualifier)) {
    return { name: typeNode.qualifier.text, typeNode };
  }
  /* c8 ignore next -- defensive: `@throws {…}` type expression isn't a recognized form. */
  return null;
}

/**
 * Walk every collected `@throws` entry and, when its outer type is a library
 * status type used inline (e.g. `BadRequestResponse<SomeBody>`), resolve the
 * full type via the TypeChecker and attach the inline schema + status. This
 * lets handlers reference library response types directly without declaring a
 * named alias first.
 *
 * @param {Map<string, ThrowsEntry[]>} jsdocThrows
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @param {Set<string>} knownNames
 */
function resolveInlineThrows(jsdocThrows, checker, ts, knownNames) {
  for (const entries of jsdocThrows.values()) {
    for (const entry of entries) {
      if (!entry.typeNode) continue;
      const status = inferStatusFromTypeNode(entry.typeNode, ts, checker);
      if (!status) continue;
      entry.status = status;
      // 204 carries no body — skip schema resolution.
      if (status === '204') continue;
      const resolved = checker.getTypeFromTypeNode(entry.typeNode);
      entry.inlineSchema = typeToSchema(resolved, checker, ts, knownNames);
    }
  }
}

/**
 * For each handler-typed slot whose name is not a registered schema, resolve
 * the slot's type node via the TypeChecker into an inline schema. This lets
 * users write inline object literals like `Request<…, { foo: Bar[] }>` and
 * still get a useful body schema (with named members `$ref`-d).
 *
 * @param {Map<string, RouteMetadata>} handlerTypes
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @param {Set<string>} knownNames
 */
function resolveInlineHandlerSlots(handlerTypes, checker, ts, knownNames) {
  const slotKeys = /** @type {const} */ (['params', 'request', 'response', 'query']);
  for (const meta of handlerTypes.values()) {
    for (const key of slotKeys) {
      const slot = meta[key];
      if (!slot?.typeNode) continue;
      if (slot.name && knownNames.has(slot.name)) continue;
      const resolved = checker.getTypeFromTypeNode(slot.typeNode);
      slot.schema = typeToSchema(resolved, checker, ts, knownNames);
      if (key === 'response') {
        const chainStatus = walkTypeChainForStatus(resolved, ts, checker, new Set());
        if (chainStatus) slot.statusFromChain = chainStatus;
        const chainContentType = walkTypeChainForContentType(resolved, ts, checker, new Set());
        if (chainContentType) slot.contentType = chainContentType;
      }
    }
  }
}

/**
 * Walk a declaration's inheritance / type-alias chain and return an HTTP
 * status code when one of the ancestors is a library-declared response type
 * listed in `STATUS_TYPES`. Returns null when no ancestor matches — that
 * makes the declaration ineligible to serve as an `@throws` response.
 *
 * @param {any} node
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<any>} [seen]
 * @returns {string | null}
 */
function inferStatusFromType(node, ts, checker, seen = new Set()) {
  if (!node || seen.has(node)) return null;
  seen.add(node);

  if (ts.isTypeAliasDeclaration(node)) {
    const found = inferFromTypeNode(node.type, ts, checker, seen);
    if (found) return found;
  }

  // JSDoc `@typedef {…} Foo` — resolve the type expression like a type alias,
  // so an inline `@typedef {ApiResponse<X, NNN>} Foo` propagates NNN into
  // `statusByType` without requiring a `.d.ts` round-trip.
  if (ts.isJSDocTypedefTag(node)) {
    const typeNode = /** @type {any} */ (node.typeExpression)?.type;
    if (typeNode) {
      const found = inferFromTypeNode(typeNode, ts, checker, seen);
      if (found) return found;
    }
  }

  if (ts.isInterfaceDeclaration(node) && node.heritageClauses) {
    for (const clause of node.heritageClauses) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of clause.types) {
        if (!ts.isExpressionWithTypeArguments(type)) continue;
        if (!ts.isIdentifier(type.expression)) continue;
        const baseName = type.expression.text;
        if (matchesLibraryResponseName(baseName)) {
          const fromLiteral = readResponseStatusArg(type.typeArguments, ts);
          if (fromLiteral) return fromLiteral;
        }
        const baseStatus = followIdentifier(type.expression, ts, checker, seen);
        if (baseStatus) return baseStatus;
      }
    }
  }

  return null;
}

/**
 * When a type extends or aliases `Response<T, N>` (or `ErrorResponse<T, N>`)
 * with `N` a numeric literal type argument, return `String(N)` so callers
 * can emit it as the HTTP status. Returns null when the second type argument
 * isn't present or isn't a numeric literal.
 *
 * @param {readonly any[] | undefined} typeArguments
 * @param {typeof import('typescript')} ts
 * @returns {string | null}
 */
function readResponseStatusArg(typeArguments, ts) {
  const statusArg = typeArguments?.[1];
  if (!statusArg) return null;
  if (ts.isLiteralTypeNode(statusArg) && ts.isNumericLiteral(statusArg.literal)) {
    return statusArg.literal.text;
  }
  return null;
}

/**
 * Resolve a JSDoc `@throws` typeNode to its HTTP status by walking the
 * TypeChecker-produced type-instance chain. This is more robust than the
 * AST-level walk for types that bounce through JSDoc-typedef indirections.
 * Returns the status string (e.g. `'400'`) or null when no chain resolves.
 *
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {string | null}
 */
function inferStatusFromTypeNode(typeNode, ts, checker) {
  if (!typeNode) return null;
  const type = checker.getTypeFromTypeNode(typeNode);
  return walkTypeChainForStatus(type, ts, checker, new Set());
}

/**
 * If a type chains (directly or via inheritance) to `ApiResponse<T, …>`,
 * return `T` (the body type) with full type-parameter substitution applied.
 * For derived types, this is read off the inherited `body` property of the
 * instance — which carries the substituted type via the TypeChecker. Returns
 * null when the chain doesn't reach `ApiResponse`.
 *
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {any | null}
 */
function extractApiResponseBody(type, ts, checker) {
  if (!type) return null;

  const symbolName = type.aliasSymbol?.name ?? type.symbol?.name;
  if (matchesLibraryResponseName(symbolName)) {
    const args = type.aliasTypeArguments ?? checker.getTypeArguments?.(type) ?? [];
    return args[0] ?? null;
  }

  if (!chainsToApiResponse(type, ts, checker, new Set())) return null;
  const bodyProp = type.getProperty?.('body');
  if (!bodyProp) return null;
  const decl = bodyProp.valueDeclaration ?? bodyProp.declarations?.[0];
  if (!decl) return null;
  return checker.getTypeOfSymbolAtLocation(bodyProp, decl);
}

/**
 * Check whether a type's instance- or declared-type chain reaches
 * `ApiResponse` / `ErrorResponse`.
 *
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<any>} seen
 * @returns {boolean}
 */
function chainsToApiResponse(type, ts, checker, seen) {
  if (!type || seen.has(type)) return false;
  seen.add(type);

  const symbolName = type.aliasSymbol?.name ?? type.symbol?.name;
  if (matchesLibraryResponseName(symbolName)) return true;

  // Aliased instances often report empty `getBaseTypes`; fall back to the
  // declared type of the symbol whose base types are populated.
  let bases = type.getBaseTypes?.() ?? [];
  if (bases.length === 0 && type.symbol) {
    const declared = checker.getDeclaredTypeOfSymbol(type.symbol);
    if (declared && declared !== type) bases = declared.getBaseTypes?.() ?? [];
  }
  for (const base of bases) {
    if (chainsToApiResponse(base, ts, checker, seen)) return true;
  }
  return false;
}

/**
 * Walk a type instance's base-type chain looking for `ApiResponse<T, N>` (or
 * `ErrorResponse<T, N>`) and read the status code from the second type
 * argument when it's a numeric literal.
 *
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<any>} seen
 * @returns {string | null}
 */
function walkTypeChainForStatus(type, ts, checker, seen) {
  return walkTypeChainForArg(type, ts, checker, seen, 1, (arg) => {
    if (arg.flags & ts.TypeFlags.NumberLiteral) return String(arg.value);
    /* c8 ignore next -- defensive: slot 1 exists but isn't a literal (e.g. unsubstituted `ApiResponse<X>` with StatusCode defaulted to `number`); walker falls through to bases. */
    return null;
  });
}

/**
 * Walk a type instance's base-type chain looking for `ApiResponse<T, N, M>`
 * (or `ErrorResponse<T, N, M>`) and read the wire media type from the third
 * type argument when it's a string literal. Returns null when no ancestor
 * pins a literal media type — callers fall back to `application/json`.
 *
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<any>} seen
 * @returns {string | null}
 */
function walkTypeChainForContentType(type, ts, checker, seen) {
  return walkTypeChainForArg(type, ts, checker, seen, 2, (arg) => {
    if (arg.flags & ts.TypeFlags.StringLiteral) return arg.value;
    /* c8 ignore next -- defensive: slot 2 exists but isn't a literal; walker falls through to bases. */
    return null;
  });
}

/**
 * Shared inheritance walker for `ApiResponse` / `ErrorResponse` chains —
 * extracts a single type-argument by index and runs `read` against the
 * substituted type. Used to read both `StatusCode` (slot 1) and `MediaType`
 * (slot 2) off the chain.
 *
 * @template T
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<any>} seen
 * @param {number} argIndex
 * @param {(arg: any) => T | null} read
 * @returns {T | null}
 */
function walkTypeChainForArg(type, ts, checker, seen, argIndex, read) {
  if (!type || seen.has(type)) return null;
  seen.add(type);

  // Check both names: aliasSymbol matches a direct `ApiResponse<…>` use,
  // while type.symbol matches an aliased instance (e.g. `type X =
  // ErrorResponse<…>`) whose structural symbol points at the underlying
  // library interface — the substituted type args live on the instance.
  if (matchesLibraryResponseName(type.aliasSymbol?.name) || matchesLibraryResponseName(type.symbol?.name)) {
    const args = type.aliasTypeArguments ?? checker.getTypeArguments?.(type) ?? [];
    const arg = args[argIndex];
    if (arg) {
      const value = read(arg);
      if (value !== null) return value;
    }
  }

  // Aliased instances often report empty `getBaseTypes`; fall back to the
  // declared type of the symbol whose base types ARE populated.
  let bases = type.getBaseTypes?.() ?? [];
  if (bases.length === 0 && type.symbol) {
    const declared = checker.getDeclaredTypeOfSymbol(type.symbol);
    if (declared && declared !== type) bases = declared.getBaseTypes?.() ?? [];
  }
  for (const base of bases) {
    const found = walkTypeChainForArg(base, ts, checker, seen, argIndex, read);
    if (found !== null) return found;
  }

  return null;
}

/**
 * dts-buddy bundles types under a `_<n>` suffix in the rolled-up declaration
 * file (e.g. `ErrorResponse_1`); strip the suffix when matching against the
 * library's canonical type names.
 *
 * @param {string | undefined} name
 * @returns {boolean}
 */
function matchesLibraryResponseName(name) {
  if (!name) return false;
  const stripped = name.replace(/_\d+$/, '');
  return stripped === 'ApiResponse' || stripped === 'ErrorResponse';
}

/**
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<any>} seen
 * @returns {string | null}
 */
function inferFromTypeNode(typeNode, ts, checker, seen) {
  if (!typeNode) return null;
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const name = typeNode.typeName.text;
    if (matchesLibraryResponseName(name)) {
      const fromLiteral = readResponseStatusArg(typeNode.typeArguments, ts);
      if (fromLiteral) return fromLiteral;
    }
    return followIdentifier(typeNode.typeName, ts, checker, seen);
  }
  if (ts.isImportTypeNode(typeNode) && typeNode.qualifier && ts.isIdentifier(typeNode.qualifier)) {
    const name = typeNode.qualifier.text;
    if (matchesLibraryResponseName(name)) {
      const fromLiteral = readResponseStatusArg(typeNode.typeArguments, ts);
      if (fromLiteral) return fromLiteral;
    }
    return followIdentifier(typeNode.qualifier, ts, checker, seen);
  }
  return null;
}

/**
 * @param {Identifier} identifier
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<any>} seen
 * @returns {string | null}
 */
function followIdentifier(identifier, ts, checker, seen) {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  for (const decl of symbol?.declarations ?? []) {
    const s = inferStatusFromType(decl, ts, checker, seen);
    if (s) return s;
  }
  return null;
}

/**
 * @param {any} node
 * @param {typeof import('typescript')} ts
 */
function isExported(node, ts) {
  return node.modifiers?.some((/** @type {any} */ m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Resolve the named specifiers of a re-export statement
 * (`export { A, B as C } from 'dep'`, `export type { T } from 'dep'`) back to
 * the underlying `interface` / `type alias` / `enum` declarations they alias,
 * so a dependency type surfaced by name from a project file registers as a
 * shared component instead of being inlined at every use site. Wildcard
 * (`export * from`) and namespace (`export * as ns from`) forms are skipped —
 * they'd pull a dependency's entire surface, the cost the `node_modules` filter
 * exists to avoid.
 *
 * @param {any} statement
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @returns {Array<{ name: string, node: any }>}
 */
function reExportedTypeDeclarations(statement, checker, ts) {
  const clause = statement.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return [];
  /** @type {Array<{ name: string, node: any }>} */
  const out = [];
  for (const element of clause.elements) {
    let symbol = checker.getSymbolAtLocation(element.name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const decl = symbol?.declarations?.find(
      (/** @type {any} */ d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isEnumDeclaration(d)
    );
    if (decl) out.push({ name: element.name.text, node: decl });
  }
  return out;
}

/**
 * Walk a source file's entire AST and return every JSDoc `@typedef` tag
 * encountered. Free-standing typedef blocks in JS files attach to whichever
 * node TypeScript's parser associates them with, so a full recursive walk is
 * the robust way to collect them all.
 *
 * @param {SourceFile} sourceFile
 * @param {typeof import('typescript')} ts
 * @returns {any[]}
 */
function findJsDocTypedefs(sourceFile, ts) {
  /** @type {any[]} */
  const out = [];
  /** @param {any} node */
  function visit(node) {
    const jsDocs = node.jsDoc;
    if (Array.isArray(jsDocs)) {
      for (const jsDoc of jsDocs) {
        const tags = jsDoc?.tags;
        if (!Array.isArray(tags)) continue;
        for (const tag of tags) {
          if (ts.isJSDocTypedefTag(tag)) out.push(tag);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return out;
}

/**
 * Ceiling on the number of object types a single top-level conversion may
 * inline-expand. Types that carry no registered `$ref` target — chiefly those
 * reached through `node_modules` (excluded from `knownNames`) — are expanded
 * in full, and a wide mutually-recursive graph (e.g. the bpmn-moddle
 * metamodel: 164 cross-referencing interfaces) re-expands each node along every
 * distinct path, blowing up combinatorially into multi-GB heaps. The per-path
 * cycle guard only breaks true back-edges, not this DAG re-expansion, so we
 * also cap the total. Any real schema stays orders of magnitude under this;
 * only pathological graphs hit it, and they degrade to opaque object stubs
 * rather than OOM.
 */
const MAX_OBJECT_EXPANSIONS = 5000;

/** @returns {{ remaining: number }} */
function createExpansionBudget() {
  return { remaining: MAX_OBJECT_EXPANSIONS };
}

/**
 * Convert a TypeScript type into an OpenAPI-compatible JSON Schema. Named
 * types that the caller has registered in `knownNames` are expected to be
 * inlined by the TOP-LEVEL call and referenced from nested calls — the
 * helper `typeToSchemaOrRef` handles the ref emission.
 *
 * @param {any} type
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @param {Set<string>} knownNames
 * @param {Set<any>} [path]
 * @param {{ remaining: number }} [budget] shared expansion counter for this conversion
 * @returns {any}
 */
function typeToSchema(type, checker, ts, knownNames, path = new Set(), budget = createExpansionBudget()) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void)) return {};
  if (isIgnoredWrapperType(type, ts)) return {};
  if (type.flags & ts.TypeFlags.String) return { type: 'string' };
  if (type.flags & ts.TypeFlags.Number) return { type: 'number' };
  if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' };
  if (type.flags & ts.TypeFlags.BigInt) return { type: 'number' };

  // Built-in wrapper-object types — caught here so the Object-branch property
  // walk doesn't expand their instance methods. `Date` → date-time string;
  // `Number`/`String`/`Boolean` are deprecated wrappers, coerce to primitives.
  const builtin = builtinObjectSchema(type);
  if (builtin) return builtin;

  if (type.flags & ts.TypeFlags.StringLiteral) return { type: 'string', enum: [type.value] };
  if (type.flags & ts.TypeFlags.NumberLiteral) return { type: 'number', enum: [type.value] };
  // Boolean literal types don't expose `.value`; their pinned value is on the
  // (internal-but-stable) `intrinsicName` as the string "true" or "false".
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: 'boolean', enum: [type.intrinsicName === 'true'] };

  if (type.flags & ts.TypeFlags.Union) {
    const nonNullish = type.types.filter(
      (/** @type {any} */ t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void))
    );
    if (nonNullish.length === 0) return { type: 'null' };
    if (nonNullish.length === 1) return typeToSchema(nonNullish[0], checker, ts, knownNames, path, budget);
    const literalValues = collectLiteralEnumValues(nonNullish, ts);
    if (literalValues) return { type: 'string', enum: literalValues };
    // Open string union — `'a' | 'b' | (string & {})`. OpenAPI has no
    // open-enum construct, so say "these values, or any string" in two
    // members instead of one `anyOf` entry per literal.
    const openEnum = openStringUnionSchema(nonNullish, ts, checker);
    if (openEnum) return openEnum;
    return {
      anyOf: nonNullish.map((/** @type {any} */ t) => typeToSchemaOrRef(t, checker, ts, knownNames, path, budget)),
    };
  }

  if (type.flags & ts.TypeFlags.Intersection) {
    const unwrapped = unwrapEmptyIntersection(type, ts, checker);
    if (unwrapped !== type) return typeToSchema(unwrapped, checker, ts, knownNames, path, budget);
  }

  if (isArrayType(type)) {
    const itemType = checker.getTypeArguments?.(type)?.[0];
    if (itemType) {
      return { type: 'array', items: typeToSchemaOrRef(itemType, checker, ts, knownNames, path, budget) };
    }
    /* c8 ignore next 2 -- defensive: an `Array` type without a resolved element type. */
    return { type: 'array' };
  }

  if (type.flags & ts.TypeFlags.Object) {
    // ApiResponse-chain types: emit the body schema, not the
    // `{ body, statusCode }` wrapper.
    const bodyType = extractApiResponseBody(type, ts, checker);
    if (bodyType) return typeToSchemaOrRef(bodyType, checker, ts, knownNames, path, budget);
    // Cycle break for un-exported self-referential types: with no registered
    // name there's no `$ref` target, so we'd recurse forever otherwise.
    if (path.has(type)) return { type: 'object' };
    // Budget break: the per-path cycle guard above stops back-edges but not
    // combinatorial re-expansion of a wide mutually-recursive DAG, which would
    // OOM. Once the shared budget is spent, emit an opaque stub instead.
    if (budget.remaining <= 0) return { type: 'object' };
    budget.remaining--;
    path.add(type);
    try {
      /** @type {Record<string, any>} */
      const properties = {};
      /** @type {string[]} */
      const required = [];
      for (const prop of type.getProperties()) {
        const entry = objectPropertyEntry(prop, checker, ts, knownNames, path, budget);
        if (!entry) continue;
        properties[entry.name] = entry.schema;
        if (!entry.optional) required.push(entry.name);
      }
      /** @type {Record<string, any>} */
      const schema = {
        type: 'object',
        properties,
        additionalProperties: indexSignatureSchema(type, checker, ts, knownNames, path, budget),
      };
      if (required.length > 0) schema.required = required;
      return schema;
    } finally {
      path.delete(type);
    }
  }
  /* c8 ignore start -- defensive fallthrough: type matched none of the known shapes. */

  return { type: 'object' };
}
/* c8 ignore stop */

/**
 * Strip empty-object members off an intersection: `string & {}` is the idiom
 * for a string that keeps literal autocomplete in `Literal | (string & {})`
 * unions, and `{}` contributes nothing to the shape. Returns the single
 * remaining member when exactly one survives, otherwise the type untouched.
 *
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {any}
 */
function unwrapEmptyIntersection(type, ts, checker) {
  if (!(type.flags & ts.TypeFlags.Intersection)) return type;
  const meaningful = type.types.filter((/** @type {any} */ t) => !isEmptyObjectType(t, ts, checker));
  return meaningful.length === 1 ? meaningful[0] : type;
}

/**
 * Schema for an open string union — literal members plus exactly one bare
 * `string` (usually spelled `string & {}` so the literals survive TypeScript's
 * subtype reduction). Emits `anyOf: [<literal enum>, { type: 'string' }]`, or
 * null when the members don't fit that shape.
 *
 * @param {any[]} members non-nullish union members
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {Record<string, any> | null}
 */
function openStringUnionSchema(members, ts, checker) {
  const LITERAL_FLAGS = ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.BooleanLiteral;
  const literals = members.filter((/** @type {any} */ t) => t.flags & LITERAL_FLAGS);
  const rest = members.filter((/** @type {any} */ t) => !(t.flags & LITERAL_FLAGS));
  if (literals.length === 0 || rest.length !== 1) return null;
  if (!(unwrapEmptyIntersection(rest[0], ts, checker).flags & ts.TypeFlags.String)) return null;
  const literalValues = collectLiteralEnumValues(literals, ts);
  if (!literalValues) return null;
  return { anyOf: [{ type: 'string', enum: literalValues }, { type: 'string' }] };
}

/**
 * Whether a type is the empty object type `{}` — an object with no members,
 * signatures, or index signatures.
 *
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {boolean}
 */
function isEmptyObjectType(type, ts, checker) {
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  if (type.getProperties().length > 0) return false;
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false;
  return (checker.getIndexInfosOfType?.(type) ?? []).length === 0;
}

/**
 * Translate the string-keyed index signature of an object type into an
 * `additionalProperties` value: `true` for `any`/`unknown` (the open-record
 * shape `Record<string, any>`), the value-type schema otherwise, and `false`
 * when the type has no string index signature (closed object).
 *
 * @param {any} type
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @param {Set<string>} knownNames
 * @param {Set<any>} path
 * @param {{ remaining: number }} [budget]
 * @returns {boolean | Record<string, any>}
 */
function indexSignatureSchema(type, checker, ts, knownNames, path, budget = createExpansionBudget()) {
  const infos = checker.getIndexInfosOfType?.(type) ?? [];
  const stringIndex = infos.find((/** @type {any} */ info) => info.keyType.flags & ts.TypeFlags.String);
  if (!stringIndex) return false;
  if (stringIndex.type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  return typeToSchemaOrRef(stringIndex.type, checker, ts, knownNames, path, budget);
}

/**
 * Build the `{ name, schema, optional }` entry for one object property, or
 * null when the property's type can't be represented (deprecated wrappers /
 * the `symbol` primitive) and should be dropped — an `{}` stub would lie about
 * accepting any value, so omitting from `properties`/`required` is safer.
 * Shared by the `getProperties()` walk and the mapped-heritage reconstruction.
 *
 * @param {TsSymbol} prop
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @param {Set<string>} knownNames
 * @param {Set<any>} path
 * @param {{ remaining: number }} [budget]
 * @returns {{ name: string, schema: Record<string, any>, optional: boolean } | null}
 */
function objectPropertyEntry(prop, checker, ts, knownNames, path, budget = createExpansionBudget()) {
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  if (!decl) return null;
  const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
  if (isIgnoredWrapperType(propType, ts)) return null;
  const propSchema = typeToSchemaOrRef(propType, checker, ts, knownNames, path, budget);
  const description = propertyDescription(prop, ts, checker);
  const defaultEntry = propertyDefault(prop, ts, checker);
  const schema = attachDefault(attachDescription(propSchema, description), defaultEntry);
  const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
  return { name: prop.name, schema, optional };
}

/** Utility wrappers whose effective shape is a mapped type over a base type. */
const MAPPED_HERITAGE_WRAPPERS = new Set(['Omit', 'Pick', 'Partial']);

/**
 * Overlay the members recovered from a collapsed `Omit`/`Pick`/`Partial`
 * heritage onto an already-built object schema. Only members the checker-driven
 * walk MISSED are added — anything the schema already carries (the interface's
 * own declarations, or an uncollapsed base) wins, so schemas that never hit the
 * index-signature collapse stay byte-identical.
 *
 * @param {any} schema the schema produced by `typeToSchema`
 * @param {any} node the interface/type-alias declaration
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<string>} knownNames
 */
function mergeMappedHeritageProperties(schema, node, ts, checker, knownNames) {
  if (!schema || schema.type !== 'object' || !schema.properties) return;
  const recovered = reconstructMappedHeritageProperties(node, ts, checker, knownNames);
  if (recovered.length === 0) return;
  for (const { name, schema: propSchema, optional } of recovered) {
    if (Object.prototype.hasOwnProperty.call(schema.properties, name)) continue;
    schema.properties[name] = propSchema;
    if (optional) continue;
    if (!schema.required) schema.required = [];
    if (!schema.required.includes(name)) schema.required.push(name);
  }
}

/**
 * Reconstruct the named members an interface/type-alias inherits from an
 * `Omit<Base, K>` / `Pick<Base, K>` / `Partial<Base>` whose `Base` carries a
 * string index signature.
 *
 * `Omit<T, K>` desugars to `Pick<T, Exclude<keyof T, K>>`; when `T` has an
 * index signature, `keyof T` widens to `string | number`, so `Exclude` keeps
 * `string | number` and the checker's apparent `getProperties()` collapses to
 * just the index signature — the named members vanish at the type level. We
 * recover them syntactically from `Base`'s declaration instead, then re-apply
 * the key filter and optionality. Returns one `objectPropertyEntry` per
 * retained member across all such bases (deduped, first declaration wins).
 *
 * @param {any} node interface or type-alias declaration
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @param {Set<string>} knownNames
 * @returns {Array<{ name: string, schema: Record<string, any>, optional: boolean }>}
 */
function reconstructMappedHeritageProperties(node, ts, checker, knownNames) {
  /** @type {Array<{ wrapper: string, baseNode: any, keysNode: any }>} */
  const refs = [];

  /** @param {any} typeNode */
  const consider = (typeNode) => {
    if (!typeNode || !ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return;
    const wrapper = typeNode.typeName.text;
    if (!MAPPED_HERITAGE_WRAPPERS.has(wrapper) || !typeNode.typeArguments?.[0]) return;
    refs.push({ wrapper, baseNode: typeNode.typeArguments[0], keysNode: typeNode.typeArguments[1] ?? null });
  };

  if (ts.isInterfaceDeclaration(node) && node.heritageClauses) {
    for (const clause of node.heritageClauses) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const heritage of clause.types) {
        // An `extends Omit<…>` heritage is an ExpressionWithTypeArguments, not a
        // TypeReferenceNode; bridge it into the same shape `consider` expects.
        if (ts.isExpressionWithTypeArguments(heritage) && ts.isIdentifier(heritage.expression)) {
          const wrapper = heritage.expression.text;
          if (MAPPED_HERITAGE_WRAPPERS.has(wrapper) && heritage.typeArguments?.[0]) {
            refs.push({ wrapper, baseNode: heritage.typeArguments[0], keysNode: heritage.typeArguments[1] ?? null });
          }
        }
      }
    }
  } else if (ts.isTypeAliasDeclaration(node)) {
    consider(node.type);
  }

  /** @type {Array<{ name: string, schema: Record<string, any>, optional: boolean }>} */
  const entries = [];
  const seen = new Set();
  const budget = createExpansionBudget();
  for (const { wrapper, baseNode, keysNode } of refs) {
    const baseType = checker.getTypeFromTypeNode(baseNode);
    // Only the index-signature collapse needs recovery — when the base is a
    // plain object the checker already reflects Omit/Pick/Partial faithfully,
    // so leaving it untouched keeps that output byte-identical.
    if (!hasStringIndexSignature(baseType, checker, ts)) continue;
    const keys = wrapper === 'Partial' ? null : collectStringLiteralKeys(keysNode, ts);
    // Omit/Pick with keys we can't resolve to string literals: bail rather than
    // risk re-adding an omitted member or dropping a picked one.
    if (wrapper !== 'Partial' && !keys) continue;
    for (const prop of baseType.getProperties()) {
      if (wrapper === 'Omit' && keys.has(prop.name)) continue;
      if (wrapper === 'Pick' && !keys.has(prop.name)) continue;
      if (seen.has(prop.name)) continue;
      const entry = objectPropertyEntry(prop, checker, ts, knownNames, new Set(), budget);
      if (!entry) continue;
      seen.add(prop.name);
      entries.push(wrapper === 'Partial' ? { ...entry, optional: true } : entry);
    }
  }
  return entries;
}

/**
 * @param {any} type
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @returns {boolean}
 */
function hasStringIndexSignature(type, checker, ts) {
  const infos = checker.getIndexInfosOfType?.(type) ?? [];
  return infos.some((/** @type {any} */ info) => info.keyType.flags & ts.TypeFlags.String);
}

/**
 * Collect the string-literal key names from an `Omit`/`Pick` second type
 * argument — a lone `'k'` (LiteralTypeNode) or a `'a' | 'b'` union. Returns
 * a Set, or null when any member isn't a plain string literal (signalling the
 * caller to skip reconstruction rather than guess).
 *
 * @param {any} keysNode
 * @param {typeof import('typescript')} ts
 * @returns {Set<string> | null}
 */
export function collectStringLiteralKeys(keysNode, ts) {
  if (!keysNode) return null;
  /** @type {any[]} */
  const members = ts.isUnionTypeNode(keysNode) ? [...keysNode.types] : [keysNode];
  const keys = new Set();
  for (const member of members) {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
      keys.add(member.literal.text);
    } else {
      return null;
    }
  }
  return keys;
}

/**
 * Emit a `$ref` to a registered schema when the type has one of our known
 * interface/alias names; otherwise inline the shape.
 *
 * @param {any} type
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @param {Set<string>} knownNames
 * @param {Set<any>} [path]
 * @param {{ remaining: number }} [budget]
 */
function typeToSchemaOrRef(type, checker, ts, knownNames, path = new Set(), budget = createExpansionBudget()) {
  const name = namedTypeName(type, ts);
  if (name && knownNames.has(name)) {
    return { $ref: `#/components/schemas/${name}` };
  }
  return typeToSchema(type, checker, ts, knownNames, path, budget);
}

/**
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @returns {string | null}
 */
function namedTypeName(type, ts) {
  if (type.aliasSymbol) return type.aliasSymbol.name;
  if (
    type.symbol &&
    type.symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.RegularEnum | ts.SymbolFlags.ConstEnum)
  ) {
    return type.symbol.name;
  }
  return null;
}

/** @param {any} type */
function isArrayType(type) {
  return type.symbol?.name === 'Array';
}

/**
 * Map a built-in wrapper-object type to its OpenAPI schema. Covers `Date`
 * (→ ISO date-time string), the library `Binary` brand (→ binary string),
 * and the deprecated JS wrapper types `Number` / `String` / `Boolean`
 * (→ their primitive equivalents — users sometimes write the wrong case;
 * coerce silently rather than walk wrapper methods).
 *
 * @param {any} type
 * @returns {Record<string, any> | null}
 */
function builtinObjectSchema(type) {
  // The library `Binary` brand is exported via dts-buddy as `Binary_1` in
  // the bundled rollup, so strip the numeric suffix before matching.
  const symbolName = type?.symbol?.name;
  const normalizedName = symbolName?.replace(/_\d+$/, '');
  switch (symbolName) {
    case 'Date':
      return { type: 'string', format: 'date-time' };
    case 'Number':
      return { type: 'number' };
    case 'String':
      return { type: 'string' };
    case 'Boolean':
      return { type: 'boolean' };
  }
  if (normalizedName === 'Binary') return { type: 'string', format: 'binary' };
  return null;
}

/**
 * Types we can't represent in OpenAPI: the deprecated `Symbol` / `Object`
 * wrappers (whose structural shape is just their constructor methods) and the
 * primitive `symbol` / `unique symbol` (which JSON.stringify drops). Properties
 * of these types are skipped in the containing schema; at the top level they
 * collapse to `{}`.
 *
 * @param {any} type
 * @param {typeof import('typescript')} ts
 * @returns {boolean}
 */
function isIgnoredWrapperType(type, ts) {
  if (!type) return false;
  const name = type.symbol?.name;
  if (name === 'Symbol' || name === 'Object') return true;
  return Boolean(type.flags & (ts.TypeFlags.ESSymbol | ts.TypeFlags.UniqueESSymbol));
}

/**
 * Read the JSDoc / TSDoc description attached to a property symbol. Returns
 * the trimmed text or null when no description is present.
 *
 * @param {TsSymbol} prop
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {string | null}
 */
function propertyDescription(prop, ts, checker) {
  const parts = prop.getDocumentationComment?.(checker) ?? [];
  const text = normalizeLineEndings(ts.displayPartsToString(parts)).trim();
  return text || null;
}

/**
 * Attach a `description` to a property's schema. OpenAPI 3.0 forbids siblings
 * on a `$ref`, so for refs we wrap the reference in an `allOf` so the
 * description can sit alongside it.
 *
 * @param {Record<string, any>} schema
 * @param {string | null} description
 */
function attachDescription(schema, description) {
  if (!description) return schema;
  if (schema && schema.$ref) return { description, allOf: [schema] };
  return { ...schema, description };
}

/**
 * Read a `@default <json-literal>` JSDoc tag off a property symbol. The tag
 * comment is parsed as JSON so any JSON-expressible value works (booleans,
 * numbers, strings, arrays, objects, null). Returned wrapped in `{ value }`
 * so legitimate `null` / `false` defaults are distinguishable from "no tag".
 * Text that isn't valid JSON (the bare `@default SE` most JSDoc users write)
 * is returned as `{ text }` so `attachDefault` can accept it where the schema
 * is string-typed.
 *
 * @param {TsSymbol} prop
 * @param {typeof import('typescript')} ts
 * @param {TypeChecker} checker
 * @returns {{ value: unknown } | { text: string } | null}
 */
function propertyDefault(prop, ts, checker) {
  const tags = prop.getJsDocTags?.(checker) ?? [];
  const tag = tags.find((/** @type {any} */ t) => t.name === 'default');
  if (!tag) return null;
  const raw = normalizeLineEndings(ts.displayPartsToString(tag.text)).trim();
  if (!raw) return null;
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { text: raw };
  }
}

/**
 * Whether a schema accepts strings — a plain `string`, a string `enum`, or an
 * `anyOf` whose members all do.
 *
 * @param {Record<string, any>} schema
 * @returns {boolean}
 */
function isStringSchema(schema) {
  if (!schema) return false;
  if (schema.type === 'string') return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.length > 0 && schema.anyOf.every(isStringSchema);
}

/**
 * Attach a `default` to a property's schema. Mirrors `attachDescription`'s
 * `$ref` handling — OpenAPI 3.0 forbids siblings on a `$ref`, so wrap in
 * `allOf` when needed. An unparsable tag (`{ text }`) is only honoured as a
 * string default on string-typed schemas; on anything else it's dropped
 * rather than emitting a default of the wrong type.
 *
 * @param {Record<string, any>} schema
 * @param {{ value: unknown } | { text: string } | null} entry
 */
function attachDefault(schema, entry) {
  if (!entry) return schema;
  let value;
  if ('text' in entry) {
    if (!isStringSchema(schema)) return schema;
    value = entry.text;
  } else {
    value = entry.value;
  }
  if (schema && schema.$ref) return { default: value, allOf: [schema] };
  return { ...schema, default: value };
}

/**
 * Build the `{ type: 'string', enum: [...] }` schema for an `EnumDeclaration`.
 * Members with a literal initializer use that literal's text; members without
 * an initializer fall back to the member's identifier name — auto-assigned
 * numeric indices are rarely useful in API documentation.
 *
 * @param {any} decl
 * @param {typeof import('typescript')} ts
 * @returns {Record<string, unknown>}
 */
function enumDeclarationToSchema(decl, ts) {
  const values = decl.members.map((/** @type {any} */ member) => {
    const init = member.initializer;
    if (init && (ts.isStringLiteral(init) || ts.isNumericLiteral(init))) {
      return init.text;
    }
    return member.name?.text ?? member.name?.escapedText ?? '';
  });
  return { type: 'string', enum: values };
}

/**
 * If every member of a union is a literal (string / number / bigint / boolean),
 * return the values stringified so the caller can emit a single
 * `{ type: 'string', enum: [...] }` schema. Returns null when any member is a
 * non-literal — those fall back to `anyOf`.
 *
 * @param {any[]} members
 * @param {typeof import('typescript')} ts
 * @returns {string[] | null}
 */
export function collectLiteralEnumValues(members, ts) {
  const LITERAL_FLAGS = ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.BooleanLiteral;
  // A `Set` dedupes while preserving first-seen order: the `Enum | `${Enum}``
  // pattern keeps each value as two distinct union members, but JSON Schema
  // enum values SHOULD be unique.
  const values = new Set();
  for (const member of members) {
    if (!(member.flags & LITERAL_FLAGS)) return null;
    const raw = member.value ?? member.intrinsicName;
    if (raw === undefined) return null;
    values.add(String(raw));
  }
  return [...values];
}

/**
 * @param {import('express').Express} app
 * @param {Record<string, object>} schemas
 * @param {Map<string, ThrowsEntry[]>} jsdocThrows
 * @param {string[]} usePrefixes
 * @param {Set<string>} privateRoutes
 * @param {Map<string, string>} descriptions
 * @param {Map<string, string>} statusByType
 * @param {Map<string, RouteMetadata>} handlerTypes
 * @param {Map<string, string[]>} tagsByRoute
 * @param {Map<string, string>} deprecations
 * @param {Map<string, SecurityRequirement[]>} securityByRoute
 * @param {Map<string, { value: unknown }>} requestExamplesByRoute
 * @param {Record<string, any> | null} securitySchemes
 * @param {string | null} title
 * @param {string | null} version
 */
function buildDocument(
  app,
  schemas,
  jsdocThrows,
  usePrefixes,
  privateRoutes,
  descriptions,
  statusByType,
  handlerTypes,
  tagsByRoute,
  deprecations,
  securityByRoute,
  requestExamplesByRoute,
  securitySchemes,
  title,
  version
) {
  /** @type {Record<string, Record<string, unknown>>} */
  const paths = Object.create(null);

  const router = /** @type {any} */ (app).router;
  for (const { route, routePath, fullPath } of walkRoutes(router, '', usePrefixes)) {
    const openApiPath = toOpenApiPath(fullPath);
    const pathParams = extractPathParams(openApiPath);
    for (const method of Object.keys(route.methods)) {
      const key = `${method} ${routePath}`;
      if (privateRoutes.has(key)) continue;
      paths[openApiPath] ??= Object.create(null);
      const metadata = handlerTypes.get(key) ?? null;
      const jsdocForRoute = jsdocThrows.get(key) ?? [];
      const description = descriptions.get(key);
      const routeTags = tagsByRoute.get(key) ?? [];
      const deprecationMessage = deprecations.has(key) ? (deprecations.get(key) ?? '') : null;
      const routeSecurity = securityByRoute.get(key) ?? [];
      const routeRequestExample = requestExamplesByRoute.get(key) ?? null;
      try {
        paths[openApiPath][method] = buildOperation(
          method,
          fullPath,
          pathParams,
          schemas,
          metadata,
          jsdocForRoute,
          description,
          statusByType,
          routeTags,
          deprecationMessage,
          routeSecurity,
          routeRequestExample
        );
        /* c8 ignore start -- buildOperation never throws against well-formed fixtures; the wrapper exists to surface unexpected errors with route context. */
      } catch (err) {
        const reason = /** @type {Error} */ (err).message;
        error('buildOperation failed for %s %s: %s', method.toUpperCase(), fullPath, reason);
        throw new Error(`Failed to build OpenAPI for ${method.toUpperCase()} ${fullPath}: ${reason}`, { cause: err });
      }
      /* c8 ignore stop */
    }
  }

  const effectiveSecuritySchemes = mergeSecuritySchemes(securitySchemes, securityByRoute);
  const reachableSchemas = pickReachableSchemas(paths, schemas);

  /** @type {Record<string, unknown>} */
  const doc = {
    openapi: '3.0.0',
    info: { title: title ?? 'API', version: version ?? '0.0.0' },
    paths,
  };
  if (Object.keys(reachableSchemas).length > 0 || effectiveSecuritySchemes) {
    /** @type {Record<string, unknown>} */
    const components = {};
    if (Object.keys(reachableSchemas).length > 0) components.schemas = reachableSchemas;
    if (effectiveSecuritySchemes) components.securitySchemes = effectiveSecuritySchemes;
    doc.components = components;
  }
  return doc;
}

/**
 * Walk every operation under `paths` for `$ref` strings, then transitively
 * walk each referenced schema body for further refs. Returns a filtered
 * schemas map containing only the reachable entries — avoids shipping a
 * `components.schemas` catalog full of types no consumer will ever touch.
 *
 * @param {Record<string, Record<string, unknown>>} paths
 * @param {Record<string, object>} schemas
 * @returns {Record<string, object>}
 */
function pickReachableSchemas(paths, schemas) {
  const reachable = new Set();
  /** @type {string[]} */
  const queue = [];
  collectSchemaRefs(paths, queue);
  while (queue.length > 0) {
    const name = /** @type {string} */ (queue.pop());
    if (reachable.has(name) || !schemas[name]) continue;
    reachable.add(name);
    collectSchemaRefs(schemas[name], queue);
  }
  /** @type {Record<string, object>} */
  const out = Object.create(null);
  for (const name of reachable) out[name] = schemas[name];
  return out;
}

const SCHEMA_REF_PREFIX = '#/components/schemas/';

/**
 * Recursively scan an arbitrary object/array for `$ref` strings of the
 * form `'#/components/schemas/<Name>'` and push the matched names onto
 * `queue`. Used by `pickReachableSchemas` for both the operation-level
 * scan and the per-schema transitive walk.
 *
 * @param {unknown} node
 * @param {string[]} queue
 */
function collectSchemaRefs(node, queue) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaRefs(item, queue);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(SCHEMA_REF_PREFIX)) {
      queue.push(value.slice(SCHEMA_REF_PREFIX.length));
    } else {
      collectSchemaRefs(value, queue);
    }
  }
}

/**
 * Combine explicit `options.security` declarations with auto-defaults for any
 * conventional scheme name (`bearerAuth`, `basicAuth`, …) referenced via
 * `@security` JSDoc tags. Explicit declarations always win over defaults.
 *
 * @param {Record<string, any> | null} explicit
 * @param {Map<string, SecurityRequirement[]>} securityByRoute
 * @returns {Record<string, any> | null}
 */
function mergeSecuritySchemes(explicit, securityByRoute) {
  /** @type {Record<string, any>} */
  const merged = { ...(explicit ?? {}) };
  for (const entries of securityByRoute.values()) {
    for (const entry of entries) {
      if (merged[entry.name]) continue;
      if (entry.name === 'apiKey' && entry.headerName) {
        merged[entry.name] = { type: 'apiKey', in: 'header', name: entry.headerName };
        continue;
      }
      if (entry.name === 'openIdConnect' && entry.openIdConnectUrl) {
        merged[entry.name] = { type: 'openIdConnect', openIdConnectUrl: entry.openIdConnectUrl };
        continue;
      }
      const fallback = DEFAULT_SECURITY_SCHEMES[entry.name];
      if (fallback) merged[entry.name] = fallback;
    }
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * @param {string} method
 * @param {string} routePath
 * @param {string[]} pathParams
 * @param {Record<string, object>} schemas
 * @param {RouteMetadata | null} metadata
 * @param {ThrowsEntry[]} jsdocThrows
 * @param {string | undefined} description
 * @param {Map<string, string>} statusByType
 * @param {string[]} tags
 * @param {string | null} deprecationMessage
 * @param {Array<{ name: string, scopes: string[], headerName?: string, openIdConnectUrl?: string }>} security
 * @param {{ value: unknown } | null} requestExample
 */
function buildOperation(
  method,
  routePath,
  pathParams,
  schemas,
  metadata,
  jsdocThrows,
  description,
  statusByType,
  tags,
  deprecationMessage,
  security,
  requestExample
) {
  const rawResponseName = metadata?.response?.name ?? null;
  const chainStatus = metadata?.response?.statusFromChain ?? null;
  const successStatus = metadata?.responseStatus ?? (rawResponseName && statusByType.get(rawResponseName)) ?? chainStatus ?? '200';

  const successDescription = metadata?.responseDescription ?? '';
  const responseContentType = metadata?.response?.contentType ?? 'application/json';
  /** @type {Record<string, unknown>} */
  const responses = {
    // 204 carries no body — skip `pickSlotSchema` so an intentionally-empty
    // `Response<NoContentResponse>` doesn't trip the unresolved-name warn.
    [successStatus]:
      successStatus === '204'
        ? { description: successDescription }
        : {
            description: successDescription,
            content: {
              [responseContentType]: { schema: pickSlotSchema(metadata?.response, 'response', method, routePath, pathParams, schemas) },
            },
          },
  };
  const effectiveThrows = metadata?.throws ?? jsdocThrows;
  for (const entry of effectiveThrows) {
    if (!entry.status || responses[entry.status]) continue;
    if (entry.status === '204' || !entry.inlineSchema) {
      responses[entry.status] = { description: entry.description ?? '' };
    } else {
      responses[entry.status] = {
        description: entry.description ?? '',
        content: {
          'application/json': { schema: entry.inlineSchema },
        },
      };
    }
  }

  /** @type {Record<string, unknown>} */
  const operation = {};
  if (tags.length > 0) operation.tags = tags;
  const composedDescription = composeDescription(description, deprecationMessage);
  if (composedDescription) operation.description = composedDescription;
  if (deprecationMessage !== null) operation.deprecated = true;
  if (security.length > 0) operation.security = security.map(({ name, scopes }) => ({ [name]: scopes }));
  operation.responses = responses;

  /** @type {Array<object>} */
  const parameters = [];
  if (pathParams.length > 0) {
    const paramsObject = resolveSlotObjectSchema(metadata?.params, schemas);
    for (const name of pathParams) {
      parameters.push({
        name,
        in: 'path',
        required: true,
        schema: paramsObject?.properties?.[name] ?? { type: 'string' },
      });
    }
  }
  if (metadata?.query) {
    parameters.push(...expandQueryParameters(metadata.query, schemas));
  }
  if (parameters.length > 0) {
    operation.parameters = parameters;
  }

  if (BODY_METHODS.has(method)) {
    const requestSchema = pickSlotSchema(metadata?.request, 'request', method, routePath, pathParams, schemas);
    const requestContentType = metadata?.request?.contentType ?? 'application/json';
    /** @type {Record<string, unknown>} */
    const contentEntry = { schema: requestSchema };
    if (requestExample) contentEntry.example = requestExample.value;
    /** @type {Record<string, unknown>} */
    const requestBody = { content: { [requestContentType]: contentEntry } };
    if (metadata?.requestDescription) requestBody.description = metadata.requestDescription;
    operation.requestBody = requestBody;
  }
  return operation;
}

/**
 * Resolve the schema for a body slot (request or response). Priority:
 *   1. Inline schema (`slot.schema`) when the slot was an object literal.
 *   2. `$ref` to the named alias when the slot's name is in the schema map.
 *   3. Naming-convention fallback (e.g. `Create<Resource>Request`).
 *   4. Generic-object stub.
 *
 * @param {SlotInfo | undefined} slot
 * @param {'request' | 'response'} kind
 * @param {string} method
 * @param {string} routePath
 * @param {string[]} pathParams
 * @param {Record<string, object>} schemas
 */
function pickSlotSchema(slot, kind, method, routePath, pathParams, schemas) {
  if (slot?.name && schemas[slot.name]) return { $ref: `#/components/schemas/${slot.name}` };
  if (slot?.schema) {
    // Named slot whose TypeChecker resolution was empty — likely a typo,
    // missing `@typedef`, or broken import.
    if (slot.name && isOpaqueSchema(slot.schema)) {
      warn(
        '%s body type "%s" at %s did not resolve — Swagger output will be `%j` (matches anything)',
        kind,
        slot.name,
        slot.typeNode ? nodeLocation(slot.typeNode) : '<unknown>',
        slot.schema
      );
    }
    return slot.schema;
  }
  const conventionName = pickSchemaNameByConvention(method, routePath, pathParams, kind, schemas);
  if (conventionName) return { $ref: `#/components/schemas/${conventionName}` };
  return { type: 'object' };
}

/** @param {Record<string, any> | null | undefined} schema */
function isOpaqueSchema(schema) {
  return Boolean(schema && typeof schema === 'object' && Object.keys(schema).length === 0);
}

/**
 * @param {SlotInfo | undefined} slot
 * @param {Record<string, object>} schemas
 * @returns {Record<string, any> | null}
 */
function resolveSlotObjectSchema(slot, schemas) {
  if (slot?.name && schemas[slot.name]) return /** @type {any} */ (schemas[slot.name]);
  if (slot?.schema) return slot.schema;
  return null;
}

/**
 * @param {SlotInfo} slot
 * @param {Record<string, object>} schemas
 * @returns {Array<object>}
 */
function expandQueryParameters(slot, schemas) {
  const schema = resolveSlotObjectSchema(slot, schemas);
  if (!schema?.properties) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: propertySchema,
  }));
}

/**
 * Recursively walk an Express router's layer stack, yielding each registered
 * route together with its full mount path. Nested `Router` instances mounted
 * via `app.use('/prefix', router)` are descended into with the prefix
 * prepended to every sub-route's path. The prefix is recovered by probing
 * the layer's matcher against known `app.use('/prefix', …)` strings from
 * the source (Express 5's Layer doesn't surface its mount path directly).
 *
 * @param {any} router
 * @param {string} mountPath
 * @param {string[]} candidatePrefixes
 * @returns {Generator<{ route: any, routePath: string, fullPath: string }>}
 */
function* walkRoutes(router, mountPath, candidatePrefixes) {
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      for (const routePath of normalizeRoutePath(layer.route.path)) {
        yield { route: layer.route, routePath, fullPath: joinPath(mountPath, routePath) };
      }
    } else if (layer.handle?.stack) {
      const prefix = findLayerMountPrefix(layer, candidatePrefixes);
      yield* walkRoutes(layer.handle, joinPath(mountPath, prefix), candidatePrefixes);
    }
  }
}

/**
 * Expand an Express route path into the list of string paths the library
 * will emit. Strings are passed through; arrays are flattened (each member
 * is normalized recursively). Non-string paths (RegExp, undefined, etc.)
 * have no OpenAPI representation — we throw a targeted error so callers
 * can identify the offending route.
 *
 * @param {unknown} routePath
 * @returns {string[]}
 */
function normalizeRoutePath(routePath) {
  if (typeof routePath === 'string') return [routePath];
  if (Array.isArray(routePath)) return routePath.flatMap((/** @type {unknown} */ p) => normalizeRoutePath(p));
  throw new Error(
    `Cannot generate an OpenAPI path for route ${describeRoutePath(routePath)} — only string paths (or arrays of strings) are supported`
  );
}

/**
 * @param {unknown} routePath
 */
function describeRoutePath(routePath) {
  if (routePath instanceof RegExp) return routePath.toString();
  /* c8 ignore next -- defensive: only RegExp is exercised; non-string non-RegExp non-array paths are unusual. */
  return JSON.stringify(routePath);
}

/**
 * @param {string} prefix
 * @param {string} suffix
 * @returns {string}
 */
function joinPath(prefix, suffix) {
  if (!prefix) return suffix;
  if (!suffix) return prefix;
  return suffix.startsWith('/') ? prefix + suffix : prefix + '/' + suffix;
}

/**
 * Probe a layer's internal matcher with each candidate prefix and return the
 * one that produces a successful match. Falls back to the empty string (no
 * prefix) when nothing matches.
 *
 * @param {any} layer
 * @param {string[]} candidatePrefixes
 * @returns {string}
 */
function findLayerMountPrefix(layer, candidatePrefixes) {
  const matcher = layer.matchers?.[0];
  if (typeof matcher !== 'function') return '';
  for (const prefix of candidatePrefixes) {
    const result = matcher(prefix);
    if (result && typeof result === 'object' && result.path === prefix) return prefix;
  }
  return '';
}

/**
 * Convert an Express 5 path to an OpenAPI path. `:name` becomes `{name}`.
 * Express's optional catch-all wildcards `{*name}` are stripped entirely
 * (OpenAPI has no equivalent — path parameters are single-segment and
 * required), then adjacent slashes are collapsed. A leading `/` is always
 * added if missing.
 *
 * @param {string} routePath
 */
function toOpenApiPath(routePath) {
  let out = routePath.replace(/:(\w+)/g, '{$1}').replace(/\{\*\w+\}/g, '');
  out = out.replace(/\/+/g, '/');
  if (out.length > 1) out = out.replace(/\/$/, '');
  if (!out.startsWith('/')) out = '/' + out;
  return out;
}

/** @param {string} openApiPath */
function extractPathParams(openApiPath) {
  return [...openApiPath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

/**
 * @param {string} routePath
 * @returns {{ singular: string | null, plural: string | null }}
 */
function deriveResource(routePath) {
  const segments = routePath.split('/').filter((s) => s && !s.startsWith(':'));
  const last = segments[segments.length - 1];
  if (!last) return { singular: null, plural: null };
  const title = last[0].toUpperCase() + last.slice(1);
  const singular = last.endsWith('s') ? title.slice(0, -1) : title;
  return { singular, plural: title };
}

/**
 * Naming-convention fallback for `request` / `response` body schemas: tries
 * `List<Plural>Response` for GET-collection endpoints and `<Verb><Singular><Kind>`
 * for everything else. Used only when the JSDoc didn't pin down a slot.
 *
 * @param {string} method
 * @param {string} routePath
 * @param {string[]} pathParams
 * @param {'request' | 'response'} kind
 * @param {Record<string, object>} schemas
 * @returns {string | null}
 */
function pickSchemaNameByConvention(method, routePath, pathParams, kind, schemas) {
  const KindTitle = kind === 'request' ? 'Request' : 'Response';
  const { singular, plural } = deriveResource(routePath);

  if (method === 'get' && pathParams.length === 0 && plural) {
    const name = `List${plural}${KindTitle}`;
    if (schemas[name]) return name;
  }

  const verb = verbFor(method);
  if (verb && singular) {
    const name = `${verb}${singular}${KindTitle}`;
    if (schemas[name]) return name;
  }
  return null;
}

/** @param {string} method */
function verbFor(method) {
  if (method === 'post') return 'Create';
  if (method === 'put' || method === 'patch') return 'Update';
  if (method === 'delete') return 'Delete';
  if (method === 'get') return 'Get';
  /* c8 ignore next -- defensive: ROUTE_METHODS already filtered to {get,post,put,patch,delete}. */
  return null;
}
