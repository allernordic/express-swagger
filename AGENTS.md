# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Fresh scaffold — no `src/` or `test/` directories exist yet. Only tooling configuration is in place. When adding code, follow the conventions baked into the configs described below; don't invent a different structure.

## Development workflow

**TDD is mandatory.** Every change — new feature or bug fix — starts with a failing test. Write the test using the `mocha-cakes-2` BDD vocabulary (`Feature` / `Scenario` / `Given` / `When` / `Then`), run it to confirm it fails for the expected reason, then write the minimum production code to make it pass, then refactor. One red/green/refactor cycle per behavior; don't batch multiple behaviors into a single implementation step. For bug fixes, reproduce the bug as a failing test before touching the code under test.

## Commands

- `npm test` — runs Mocha (expects tests under `./test`, loads `./test/helpers/setup.js`).
- `npm run lint` — runs `eslint . --cache` followed by `prettier . -c`.
- Run a single test file: `npx mocha path/to/test.js`.
- Filter by test name: `npx mocha --grep "pattern"`.
- Type-check (no emit of JS): `npx tsc --noEmit` — the project uses `emitDeclarationOnly` so `tsc` is a checker, not a compiler.
- Node version: 22 (see `.nvmrc`).

## Language and module system

- **JavaScript with JSDoc types, checked by TypeScript.** `tsconfig.json` sets `allowJs: true`, `checkJs: true`, `emitDeclarationOnly: true`, `rootDir: src`, and includes `src/**/*` plus `types`. Source files are `.js`; type information lives in JSDoc annotations and the `types/` directory. Do **not** add `.ts` source files — the build only emits `.d.ts` declarations.
- `package.json` declares `"type": "module"` — this is an ESM package. Use `import`/`export`, not `require`/`module.exports`. When importing local files, include the `.js` extension (ESM requires it).
- TypeScript is configured `strict` with `strictNullChecks: false`, `noUnusedLocals: true`, `noUnusedParameters: true`.
- Path alias: `types` → `./types/types.js`.

## Test framework

- Mocha with the `mocha-cakes-2` BDD UI (Gherkin-style `Feature` / `Scenario` / `Given` / `When` / `Then`). **Feature specs** use this vocabulary; **unit specs** use plain `describe` / `it` (mocha-cakes-2 extends the `bdd` UI, so both are available). See the folder layout for which is which.
- `chai/register-expect.js` is auto-required, so `expect` is a global in tests — don't re-import it.
- Tests must be `.js` (extension pinned in `.mocharc.json`), discovered recursively, 10s timeout.
- Mocha's `file` option loads `./test/helpers/setup.js` before the suite — put shared fixtures/hooks there.
- **HTTP requests against an Express app must go through `supertest`** (`request(app).get(...)`). Do not hand-roll `app.listen(0)` + `fetch` — supertest manages the server lifecycle internally.
- **Test observable behavior, never logging.** Do not confirm behavior by capturing `debug`/log output (overriding `createDebug.log` and asserting a line was emitted) — logs are incidental, not the contract. Assert on the output document (`doc.paths`, `doc.components.schemas`), thrown errors, or tractability. Never add a production log line purely as a test hook. If a property is only observable via a log, it's an internal one — unit-test the unit that owns it (see below), or assert its user-facing consequence.

### Test folder layout

- **BDD feature tests:** `test/feature/<name>-feature.js`. The `-feature` suffix is mandatory on these files (so specs are identifiable by filename alone, independent of directory). Feature specs exercise the public API (`buildSwaggerDocument`, the CLI) end to end.
- **Unit tests:** `test/src/<module>-test.js`, mirroring the `src/` layout (`createLazySchemaCatalog` in `src/index.js` → `test/src/lazy-schema-catalog-test.js`), written with plain `describe` / `it` (not `Feature` / `Scenario`). Unit-test internal units in isolation rather than driving them through `buildSwaggerDocument`. To make a unit importable, `export` it from its existing module and import it directly (`../../src/index.js`) — don't spin up a one-function file. Such an `export` does **not** widen the public API: the published `.d.ts` is generated from the hand-written `types/bundle.d.ts`, so only what that re-exports is public. Prefer a unit test over a feature test whenever the behavior is an internal concern (lazy evaluation, memoization, pure transforms); `c8` covering the relevant lines is a sufficient bar.
- **Coverage of unreachable defensive branches:** guard code that can't be reached with a peer-compatible environment (e.g. the `ts.sys` guard for the TypeScript 7 native port) is marked `/* c8 ignore … -- reason */` rather than contorting a test to hit it.
- **Shared test utilities:** `test/helpers/<subject>.js`. Do **not** append `-helper` / `_helper` / `.helper` to helper filenames — the directory name already implies it. Name by subject (`test/helpers/fake-express.js`, not `test/helpers/fake-express-helper.js`).
- **Fixture Express app:** `./example/` (npm workspace, top-level sibling of `test/`) is a self-contained mini-package — its own `package.json` (`"type": "module"`, `"private": true`), its own `tsconfig.json`, its own `types/` directory for shared JSDoc typedefs (mirroring the root's `types/types.js` convention), and `index.js` as the app entry. Feature specs feed this app into the library under test. The fixture is not TDD-driven — the feature specs that consume it are. Keep it realistic: it represents how a downstream consumer would structure their own Express app.
- The declared splits are `feature`, `src` (unit), and `helpers` (with the example app living at the repo root, not under `test/`). Do not introduce other sibling folders like `test/integration/` without asking.

## Code conventions

- **Maps keyed by user-controlled strings use `Object.create(null)`, not `{}`.** The library reads Express route paths and exported TypeScript type names from the consumer's source — both can in principle be `__proto__` / `constructor` / `prototype`, which would mutate `Object.prototype` if assigned into a regular object. Null-proto containers treat those as plain keys and JSON-serialize identically. Applies to anything `Record<string, …>` written via `obj[userKey] = …`. No inline comment is needed at the site — this convention covers it.

## Formatting

Prettier: 2-space indent, 140 print width, single quotes, `trailingComma: es5`. Files under `types/index.d.ts`, `lib/`, `tmp/`, `coverage`, `docs`, `CHANGELOG.md` are ignored by Prettier.

## Dependencies worth knowing

- `express` 5.x (dev dependency — likely for test fixtures / example apps, since it's not a runtime dep).
