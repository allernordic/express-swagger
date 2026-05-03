# Changelog

## v0.0.7 — 2026-05-03

### Added

- **`Binary` brand type** for binary payload fields (file uploads, raw bytes). A property typed `Binary` emits as `{ type: 'string', format: 'binary' }` — the standard OpenAPI shape for upload fields.
- **`FormBody<T>` and `MultipartBody<T>` request-body wrappers.** Wrap your payload type in the `Request<P, ResBody, ReqBody>` slot to switch the emitted `requestBody` content key from `application/json` to `application/x-www-form-urlencoded` (`FormBody<T>`) or `multipart/form-data` (`MultipartBody<T>`). The library peels the wrapper before resolving the body schema, so `T` documents the wire shape directly. Combine with `Binary`-typed fields on `T` to document multer-style file-upload endpoints.
- **Third generic on `ApiResponse<T, N, M>` / `ErrorResponse<T, N, M>` for response media type.** `M extends string = 'application/json'` flows off the chain into the emitted `responses[N].content[M]` key the same way `N` (status) does — `Response<HtmlResponse<string>>` emits `text/html`, `ApiResponse<Binary, 200, 'image/png'>` emits `image/png`, etc. The status-typed convenience aliases (`BadRequestResponse<T>`, `CreatedResponse<T>`, …) inherit the default `'application/json'`. The library walks the chain looking for a string-literal at type-arg slot 2 the same way it already walks for the numeric-literal status at slot 1.
- **`HtmlResponse<T = string>` brand**, defined as `extends ApiResponse<T, 200, 'text/html'>`. Routes typed `HtmlResponse<string>` (or wrapped in `Response<…>`) emit `text/html` — same convenience pattern as `CreatedResponse<T>` / `NoContentResponse` for status codes.

### Changed

- **`components.schemas` only ships types reachable from operations.** Previously every exported `interface` / `type alias` / `enum` and every JSDoc `@typedef` in the program was emitted, regardless of whether any handler referenced it. The library now scans the `paths` tree for `$ref` strings, transitively walks each referenced schema body for further `$ref`s, and drops anything not in the reachable set. Heritage-only relationships (`interface UserRecord extends BaseUser`) are inlined rather than `$ref`'d, so a base type only kept by inheritance will be pruned — compose via a property if you need it surfaced separately.

### Removed

- **`@contentType <media-type>` JSDoc tag** (added briefly in v0.0.6) is gone — pin the response media type via the third generic on `ApiResponse<T, N, M>` instead (`Response<HtmlResponse<string>>`, `ApiResponse<Binary, 200, 'image/png'>`, etc.). The tag had no users between v0.0.6 and v0.0.7, so it's removed outright rather than deprecated.

### Fixed

- **`walkTypeChainForStatus` now also matches the structural symbol name** (not just `aliasSymbol.name`), so `type X = ErrorResponse<Body, NNN>` aliases used directly in `@throws` resolve their literal status correctly even when the alias-name short-circuit would otherwise skip the underlying `ErrorResponse` symbol.
- **`scripts/toc.js` escapes backslashes before escaping `*`** when slugifying README headlines, so a future headline containing `\` doesn't end up double-escaping the backslash we add in front of `*`. Flagged by CodeQL as incomplete-string-encoding; no current headline is affected.

## v0.0.6 — 2026-05-03

### Added

- **`@contentType <media-type>` JSDoc tag** for overriding the response media type. Default stays `application/json`. Useful for HTML / JS / image / binary responses, e.g. `@contentType text/html` on a handler typed `Response<string>` emits the response under `text/html` instead of `application/json`. Surfaces as `RouteMetadata.responseContentType` on the public type.
- **`@internal` joins `@private` / `@ignore` / `@protected` as a hide-from-doc tag.** Matches TypeScript's `stripInternal` convention — handlers marked `@internal` no longer appear in the emitted OpenAPI document.

### Fixed

- **TS utility wrappers are peeled before resolving the slot identifier.** `Promise<T>` / `Awaited<T>` / `NonNullable<T>` / `Required<T>` / `Readonly<T>` / `ReturnType<F>` no longer leak the wrapper name (`'Promise'` etc.) as the slot's schema identifier — `slotInfoFromTypeNode` now walks down the typeNode taking the first type argument until it lands on something that isn't a peelable wrapper. So `Response<Promise<UserRecord>>` correctly emits `$ref: UserRecord`. Transformations like `Partial` / `Pick` / `Omit` are deliberately left alone since they produce a different shape.
- **Debug warn locations no longer back out of cwd.** `nodeLocation` previously emitted `path.relative(cwd, file)` unconditionally, which produced unhelpful `../src/foo.js:…` paths for files outside the working directory. It now keeps inside-cwd files as short relative paths and falls back to the absolute path when the relative form would start with `..` — both forms stay editor-clickable.

## v0.0.5 — 2026-05-02

### Fixed

- **JS prototype-assigned handlers are recognized.** `Class.prototype.method = function () {…}` declares the symbol on the LHS `PropertyAccessExpression` of the `=` `BinaryExpression`, not as a `MethodDeclaration`. `handlerFromSymbol` now climbs from a `PropertyAccessExpression` declaration up to its `=` parent and returns the RHS function/arrow, so middleware patterns like `instance.method.bind(instance)` finally pick up the prototype-assigned method's JSDoc.

## v0.0.4 — 2026-05-02

### Fixed

- **Cross-file imported handlers are now resolved.** `resolveIdentifierToHandler` previously stopped at the alias symbol whose declaration is an `ImportSpecifier`. It now follows `checker.getAliasedSymbol(symbol)` first, so `import { handler } from './…'; app.get('/x', handler)` picks up the original `FunctionDeclaration`'s JSDoc. The most impactful real-world fix.
- **`.bind(thisArg)`-wrapped handlers are recognized.** `findHandlerFunction` now special-cases `<expr>.bind(…)` calls and recurses into the bound expression — both `freeFn.bind(null)` (identifier LHS) and `instance.method.bind(instance)` (property-access LHS, common with class-based middleware). The latter resolves through to the underlying `MethodDeclaration`, which `parseHandlerTypes` reads JSDoc from like any other function-like.

## v0.0.3 — 2026-05-02

### Fixed

- **CLI no longer treats Express apps as factories.** `bin/express-swagger.js` previously did `typeof === 'function' ? await factoryOrApp() : factoryOrApp`; Express apps are themselves callable, so `export default app` crashed with `Cannot read properties of undefined (reading 'setHeader')`. The CLI now probes `app.set` / `app.use` marker methods and only invokes the export when those are missing.
- **`||` / `??` route paths are recognized.** `resolveStaticString` previously handled only `+`, identifiers, and template literals — patterns like `const basePath = options?.basePath || '/widgets'` broke the route walk. The function now resolves logical-OR / nullish-coalesce expressions, preferring the LHS when it's statically resolvable and falling back to the RHS literal.
- **JSDoc on factory-wrapped named handlers is picked up.** `findHandlerFunction`'s inner `CallExpression` walk previously only matched `ArrowFunction` / `FunctionExpression` — `app.get('/x', factory(namedHandler))` lost `namedHandler`'s JSDoc. The inner loop now also resolves identifier sub-args via `resolveIdentifierToHandler`.
