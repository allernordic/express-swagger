import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createDebug from 'debug';
import ts from 'typescript';

const debug = createDebug('aller-express-swagger');
const warn = debug.extend('warn');
const error = debug.extend('error');

/**
 * @template [ResBody=unknown]
 * @template {number} [StatusCode=number]
 * @typedef {import('types').ApiResponse<ResBody, StatusCode>} ApiResponse
 */

/**
 * @template T
 * @template {number} [StatusCode=number]
 * @typedef {import('types').ErrorResponse<T, StatusCode>} ErrorResponse
 */

/**
 * @template T
 * @typedef {import('types').BadRequestResponse<T>} BadRequestResponse
 */

/**
 * @template T
 * @typedef {import('types').UnauthorizedResponse<T>} UnauthorizedResponse
 */

/**
 * @template T
 * @typedef {import('types').ForbiddenResponse<T>} ForbiddenResponse
 */

/**
 * @template T
 * @typedef {import('types').NotFoundResponse<T>} NotFoundResponse
 */

/**
 * @template T
 * @typedef {import('types').ConflictResponse<T>} ConflictResponse
 */

/**
 * @template T
 * @typedef {import('types').InternalServerErrorResponse<T>} InternalServerErrorResponse
 */

/**
 * @template T
 * @typedef {import('types').BadGatewayResponse<T>} BadGatewayResponse
 */

/**
 * @template T
 * @typedef {import('types').CreatedResponse<T>} CreatedResponse
 */

/**
 * @typedef {import('types').NoContentResponse} NoContentResponse
 */

/** @typedef {import('types').ThrowsEntry} ThrowsEntry */
/** @typedef {import('types').SlotInfo} SlotInfo */
/** @typedef {import('types').RouteMetadata} RouteMetadata */
/** @typedef {import('types').SecurityRequirement} SecurityRequirement */
/** @typedef {import('types').LoadedTsconfig} LoadedTsconfig */

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
        title: null,
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
    securitySchemes,
    loaded.title
  );
  const schemas = /** @type {Record<string, unknown> | undefined} */ (doc.components)?.schemas ?? {};
  debug('OpenAPI document done — %d paths, %d schemas', Object.keys(doc.paths).length, Object.keys(schemas).length);
  return doc;
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

    if (fileName.endsWith('.d.ts')) {
      for (const statement of sourceFile.statements) {
        if (!isExported(statement, ts)) continue;
        if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEnumDeclaration(statement)) continue;
        const name = statement.name.text;
        if (knownNames.has(name)) continue;
        knownNames.add(name);
        declarations.push({ name, node: statement });
      }
      continue;
    }

    for (const tag of findJsDocTypedefs(sourceFile, ts)) {
      const name = tag.name?.text;
      if (!name || knownNames.has(name)) continue;
      knownNames.add(name);
      declarations.push({ name, node: tag });
    }
  }

  /** @type {Record<string, object>} */
  const schemas = {};
  /** @type {Map<string, string>} */
  const statusByType = new Map();
  for (const { name, node } of declarations) {
    if (ts.isEnumDeclaration(node)) {
      // `.d.ts` enum members without initializers report no TypeChecker value
      // (flags: Enum, value: undefined) — build from the AST so we can fall
      // back to member names instead of auto-assigned indices.
      schemas[name] = enumDeclarationToSchema(node, ts);
    } else {
      const anchor = ts.isJSDocTypedefTag(node) ? node.name : node;
      const type = checker.getTypeAtLocation(anchor);
      schemas[name] = typeToSchema(type, checker, ts, knownNames);
    }
    const status = inferStatusFromType(node, ts, checker);
    if (status) statusByType.set(name, status);
  }

  const { jsdocThrows, privateRoutes, descriptions, handlerTypes, tags, deprecations, security } = collectRouteMetadata(
    program,
    ts,
    checker
  );
  resolveInlineThrows(jsdocThrows, checker, ts, knownNames);
  resolveInlineHandlerSlots(handlerTypes, checker, ts, knownNames);
  const usePrefixes = collectUsePrefixes(program, ts);
  const title = await readNearestPackageDescription(configDir);
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
    title,
  };
}

/**
 * Walk up from `startDir` looking for the nearest `package.json` and return
 * its `description` field (if present). Used to populate `info.title` on the
 * emitted OpenAPI document.
 *
 * @param {string} startDir
 * @returns {Promise<string | null>}
 */
async function readNearestPackageDescription(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, 'package.json');
    try {
      const raw = await readFile(candidate, 'utf8');
      const pkg = JSON.parse(raw);
      if (typeof pkg.description === 'string' && pkg.description.length > 0) return pkg.description;
    } catch {
      /* Missing or malformed — keep searching the parent. */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
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
 * @returns {{ jsdocThrows: Map<string, ThrowsEntry[]>, privateRoutes: Set<string>, descriptions: Map<string, string>, handlerTypes: Map<string, RouteMetadata>, tags: Map<string, string[]>, deprecations: Map<string, string>, security: Map<string, SecurityRequirement[]> }}
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
        const types = handlerFn ? parseHandlerTypes(handlerFn, ts, checker) : null;
        const contentType = extractJsDocContentType(jsDocSource, ts);
        const metadata = types ?? (contentType ? /** @type {RouteMetadata} */ ({}) : null);
        if (metadata && contentType) metadata.responseContentType = contentType;
        const tagList = extractJsDocTagList(jsDocSource, ts);
        const deprecationMessage = extractDeprecation(jsDocSource, ts);
        const securityList = extractJsDocSecurity(jsDocSource, ts);
        for (const path of route.paths) {
          const key = `${route.method} ${path}`;
          if (entries.length > 0) jsdocThrows.set(key, entries);
          if (isPrivate) privateRoutes.add(key);
          if (description) descriptions.set(key, description);
          if (metadata) handlerTypes.set(key, metadata);
          if (tagList.length > 0) tags.set(key, tagList);
          if (deprecationMessage !== null) deprecations.set(key, deprecationMessage);
          if (securityList.length > 0) security.set(key, securityList);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    visit(sourceFile);
  }

  return { jsdocThrows, privateRoutes, descriptions, handlerTypes, tags, deprecations, security };
}

/**
 * Parse the request handler's `@param` tags for `Request<P, ResBody, ReqBody,
 * Query>` and `Response<Body>` generics. Returns `null` when nothing was
 * extractable. Only named-identifier generic arguments produce metadata — an
 * inline `{}` or a keyword like `unknown` is ignored.
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
      // Library `ApiResponse<Body, StatusCode>` — slot 2 pins the success status.
      const [body, maybeStatus] = head.args;
      const slot = slotInfoFromTypeNode(body, ts);
      if (slot) out.response = slot;
      if (description) out.responseDescription = description;
      if (maybeStatus && ts.isLiteralTypeNode(maybeStatus) && ts.isNumericLiteral(maybeStatus.literal)) {
        out.responseStatus = maybeStatus.literal.text;
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
      }
    }
  }
  return out.params || out.request || out.response || out.query ? out : null;
}

/**
 * @param {any} typeNode
 * @param {typeof import('typescript')} ts
 * @returns {SlotInfo | undefined}
 */
function slotInfoFromTypeNode(typeNode, ts) {
  if (!typeNode) return undefined;
  const peeled = peelUtilityWrappers(typeNode, ts);
  const name = identifierFromTypeNode(peeled, ts);
  return name ? { name, typeNode: peeled } : { typeNode: peeled };
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
    const text = typeof comment === 'string' ? comment : ts.displayPartsToString(comment);
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
    const text = typeof comment === 'string' ? comment : ts.displayPartsToString(comment);
    const trimmed = text.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Read a `@contentType <media-type>` JSDoc tag off the handler. Returns the
 * trimmed media type (e.g. `'text/html'`, `'image/png'`) or null when the
 * tag is absent. Used by `buildOperation` as the response's `content[…]`
 * key in place of the default `'application/json'`.
 *
 * @param {any} fn
 * @param {typeof import('typescript')} ts
 * @returns {string | null}
 */
function extractJsDocContentType(fn, ts) {
  for (const tag of getDirectJsDocTags(fn)) {
    if (tag.tagName?.text !== 'contentType') continue;
    return jsDocTagComment(tag, ts);
  }
  return null;
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
    const text = typeof comment === 'string' ? comment : ts.displayPartsToString(comment);
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
  const text = typeof comment === 'string' ? comment : ts.displayPartsToString(/** @type {any} */ (comment));
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
  if (!type || seen.has(type)) return null;
  seen.add(type);

  // Check both names: aliasSymbol matches a direct `ApiResponse<…>` use,
  // while type.symbol matches an aliased instance (e.g. `type X =
  // ErrorResponse<…>`) whose structural symbol points at the underlying
  // library interface — the substituted type args live on the instance.
  if (matchesLibraryResponseName(type.aliasSymbol?.name) || matchesLibraryResponseName(type.symbol?.name)) {
    const args = type.aliasTypeArguments ?? checker.getTypeArguments?.(type) ?? [];
    const statusArg = args[1];
    if (statusArg && statusArg.flags & ts.TypeFlags.NumberLiteral) {
      return String(statusArg.value);
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
    const found = walkTypeChainForStatus(base, ts, checker, seen);
    if (found) return found;
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
 * Convert a TypeScript type into an OpenAPI-compatible JSON Schema. Named
 * types that the caller has registered in `knownNames` are expected to be
 * inlined by the TOP-LEVEL call and referenced from nested calls — the
 * helper `typeToSchemaOrRef` handles the ref emission.
 *
 * @param {any} type
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @param {Set<string>} knownNames
 * @returns {any}
 */
function typeToSchema(type, checker, ts, knownNames, path = new Set()) {
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

  if (type.flags & ts.TypeFlags.Union) {
    const nonNullish = type.types.filter(
      (/** @type {any} */ t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void))
    );
    if (nonNullish.length === 0) return { type: 'null' };
    if (nonNullish.length === 1) return typeToSchema(nonNullish[0], checker, ts, knownNames, path);
    const literalValues = collectLiteralEnumValues(nonNullish, ts);
    if (literalValues) return { type: 'string', enum: literalValues };
    return {
      anyOf: nonNullish.map((/** @type {any} */ t) => typeToSchemaOrRef(t, checker, ts, knownNames, path)),
    };
  }

  if (isArrayType(type)) {
    const itemType = checker.getTypeArguments?.(type)?.[0];
    if (itemType) {
      return { type: 'array', items: typeToSchemaOrRef(itemType, checker, ts, knownNames, path) };
    }
    /* c8 ignore next 2 -- defensive: an `Array` type without a resolved element type. */
    return { type: 'array' };
  }

  if (type.flags & ts.TypeFlags.Object) {
    // ApiResponse-chain types: emit the body schema, not the
    // `{ body, statusCode }` wrapper.
    const bodyType = extractApiResponseBody(type, ts, checker);
    if (bodyType) return typeToSchemaOrRef(bodyType, checker, ts, knownNames, path);
    // Cycle break for un-exported self-referential types: with no registered
    // name there's no `$ref` target, so we'd recurse forever otherwise.
    if (path.has(type)) return { type: 'object' };
    path.add(type);
    try {
      /** @type {Record<string, any>} */
      const properties = {};
      /** @type {string[]} */
      const required = [];
      for (const prop of type.getProperties()) {
        const decl = prop.valueDeclaration ?? prop.declarations?.[0];
        if (!decl) continue;
        const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
        // Drop properties we can't represent: deprecated wrappers and the
        // `symbol` primitive. An `{}` stub would lie about accepting any
        // value, so omitting from `properties` and `required` is safer.
        if (isIgnoredWrapperType(propType, ts)) continue;
        const propSchema = typeToSchemaOrRef(propType, checker, ts, knownNames, path);
        const description = propertyDescription(prop, ts, checker);
        properties[prop.name] = attachDescription(propSchema, description);
        const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        if (!optional) required.push(prop.name);
      }
      /** @type {Record<string, any>} */
      const schema = { type: 'object', properties, additionalProperties: false };
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
 * Emit a `$ref` to a registered schema when the type has one of our known
 * interface/alias names; otherwise inline the shape.
 *
 * @param {any} type
 * @param {TypeChecker} checker
 * @param {typeof import('typescript')} ts
 * @param {Set<string>} knownNames
 * @param {Set<any>} [path]
 */
function typeToSchemaOrRef(type, checker, ts, knownNames, path = new Set()) {
  const name = namedTypeName(type, ts);
  if (name && knownNames.has(name)) {
    return { $ref: `#/components/schemas/${name}` };
  }
  return typeToSchema(type, checker, ts, knownNames, path);
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
 * (→ ISO date-time string) and the deprecated JS wrapper types `Number` /
 * `String` / `Boolean` (→ their primitive equivalents — users sometimes write
 * the wrong case; coerce silently rather than walk wrapper methods).
 *
 * @param {any} type
 * @returns {Record<string, any> | null}
 */
function builtinObjectSchema(type) {
  switch (type?.symbol?.name) {
    case 'Date':
      return { type: 'string', format: 'date-time' };
    case 'Number':
      return { type: 'number' };
    case 'String':
      return { type: 'string' };
    case 'Boolean':
      return { type: 'boolean' };
    default:
      return null;
  }
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
  const text = ts.displayPartsToString(parts).trim();
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
function collectLiteralEnumValues(members, ts) {
  const LITERAL_FLAGS = ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.BooleanLiteral;
  const values = [];
  for (const member of members) {
    if (!(member.flags & LITERAL_FLAGS)) return null;
    const raw = member.value ?? member.intrinsicName;
    if (raw === undefined) return null;
    values.push(String(raw));
  }
  return values;
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
 * @param {Record<string, any> | null} securitySchemes
 * @param {string | null} title
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
  securitySchemes,
  title
) {
  /** @type {Record<string, Record<string, unknown>>} */
  const paths = {};

  const router = /** @type {any} */ (app).router;
  for (const { route, routePath, fullPath } of walkRoutes(router, '', usePrefixes)) {
    const openApiPath = toOpenApiPath(fullPath);
    const pathParams = extractPathParams(openApiPath);
    for (const method of Object.keys(route.methods)) {
      const key = `${method} ${routePath}`;
      if (privateRoutes.has(key)) continue;
      paths[openApiPath] ??= {};
      const metadata = handlerTypes.get(key) ?? null;
      const jsdocForRoute = jsdocThrows.get(key) ?? [];
      const description = descriptions.get(key);
      const routeTags = tagsByRoute.get(key) ?? [];
      const deprecationMessage = deprecations.has(key) ? (deprecations.get(key) ?? '') : null;
      const routeSecurity = securityByRoute.get(key) ?? [];
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
          routeSecurity
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
    info: { title: title ?? 'API', version: '0.0.0' },
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
  const out = {};
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
  security
) {
  const rawResponseName = metadata?.response?.name ?? null;
  const chainStatus = metadata?.response?.statusFromChain ?? null;
  const successStatus = metadata?.responseStatus ?? (rawResponseName && statusByType.get(rawResponseName)) ?? chainStatus ?? '200';

  const successDescription = metadata?.responseDescription ?? '';
  const responseContentType = metadata?.responseContentType ?? 'application/json';
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
    /** @type {Record<string, unknown>} */
    const requestBody = {
      content: {
        'application/json': { schema: requestSchema },
      },
    };
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
