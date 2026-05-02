# Changelog

## v0.0.3 — 2026-05-02

### Fixed

- **CLI no longer treats Express apps as factories.** `bin/express-swagger.js` previously did `typeof === 'function' ? await factoryOrApp() : factoryOrApp`; Express apps are themselves callable, so `export default app` crashed with `Cannot read properties of undefined (reading 'setHeader')`. The CLI now probes `app.set` / `app.use` marker methods and only invokes the export when those are missing.
- **`||` / `??` route paths are recognized.** `resolveStaticString` previously handled only `+`, identifiers, and template literals — patterns like `const basePath = options?.basePath || '/widgets'` broke the route walk. The function now resolves logical-OR / nullish-coalesce expressions, preferring the LHS when it's statically resolvable and falling back to the RHS literal.
- **JSDoc on factory-wrapped named handlers is picked up.** `findHandlerFunction`'s inner `CallExpression` walk previously only matched `ArrowFunction` / `FunctionExpression` — `app.get('/x', factory(namedHandler))` lost `namedHandler`'s JSDoc. The inner loop now also resolves identifier sub-args via `resolveIdentifierToHandler`.
