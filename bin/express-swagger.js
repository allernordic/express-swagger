#!/usr/bin/env node
/* eslint-disable no-console, no-process-exit */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { buildSwaggerDocument } from '../src/index.js';

/**
 * Walk up from `startDir` looking for the nearest `tsconfig.json`.
 *
 * @param {string} startDir
 * @returns {string | null}
 */
function findClosestTsconfig(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const USAGE = `Usage: express-swagger <app-module> [options]

Arguments:
  <app-module>           Path to the module that exports the Express app (or a factory).

Options:
  --tsconfig <path>      Path to tsconfig.json (defaults to the closest tsconfig.json
                         found by walking up from the app module's directory).
  --export <name>        Named export to use as the app or app factory (default: "setupApp").
  --out <path>           Output path for the OpenAPI document (default: "swagger.json").
  --minify               Write the JSON without indentation (default: indented with 2 spaces).
  --help                 Show this help.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tsconfig: { type: 'string' },
    export: { type: 'string', default: 'setupApp' },
    out: { type: 'string', default: 'swagger.json' },
    minify: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || positionals.length === 0) {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}

const appModulePath = path.resolve(positionals[0]);
const outPath = path.resolve(values.out ?? 'swagger.json');

// If the app module statically imports the output file (e.g. to bind it to a
// `/swagger` route), the import would fail before we get a chance to build.
// Pre-create the parent directory and a `{}` placeholder so the import
// resolves; the real document overwrites it once it's built.
await mkdir(path.dirname(outPath), { recursive: true });
if (!existsSync(outPath)) {
  await writeFile(outPath, '{}');
}

const appModule = await import(pathToFileURL(appModulePath).href);

const exportName = values.export ?? 'setupApp';
const factoryOrApp = appModule[exportName] ?? appModule.default;
if (factoryOrApp === undefined) {
  console.error(`Export "${exportName}" (and no default export) found in ${appModulePath}`);
  process.exit(1);
}

const app = typeof factoryOrApp === 'function' ? await factoryOrApp() : factoryOrApp;

const tsconfigPath = values.tsconfig ? path.resolve(values.tsconfig) : findClosestTsconfig(path.dirname(appModulePath));
const tsconfigRef = tsconfigPath ? pathToFileURL(tsconfigPath) : undefined;
const doc = await buildSwaggerDocument(app, { tsconfig: tsconfigRef });

const serialized = values.minify ? JSON.stringify(doc) : JSON.stringify(doc, null, 2);
await writeFile(outPath, serialized);
process.stdout.write(`Wrote OpenAPI document to ${outPath}\n`);
