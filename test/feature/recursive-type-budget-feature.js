import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSwaggerDocument } from '@aller/express-swagger';

/** @type {string[]} */
const createdTmpDirs = [];

before(async () => {
  await mkdir('./tmp', { recursive: true });
});

after(async () => {
  await Promise.all(createdTmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  createdTmpDirs.length = 0;
});

/**
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function makeTmpDir(prefix) {
  const dir = await mkdtemp(path.join('./tmp', prefix));
  createdTmpDirs.push(dir);
  return dir;
}

/**
 * Generate a mutually-recursive interface "metamodel": a binary diamond of
 * `depth` levels where every level references the next through TWO properties.
 * Inline expansion (no `$ref` target, because these types live in node_modules
 * and are never registered as named schemas) therefore re-expands each level
 * twice per parent — 2^depth object nodes — the exact shape that OOMs the
 * bpmn-moddle metamodel.
 *
 * @param {number} depth
 * @returns {string}
 */
function generateDiamond(depth) {
  const lines = [];
  for (let i = 0; i < depth; i++) {
    lines.push(`export interface N${i} { a: N${i + 1}; b: N${i + 1}; }`);
  }
  lines.push(`export interface N${depth} { value: string; }`);
  return lines.join('\n') + '\n';
}

/**
 * Depth-first walk of every plain object/array reachable in a JSON schema,
 * invoking `visit` on each object node.
 *
 * @param {unknown} node
 * @param {(obj: Record<string, any>) => void} visit
 */
function walkSchema(node, visit) {
  if (Array.isArray(node)) {
    for (const child of node) walkSchema(child, visit);
    return;
  }
  if (node && typeof node === 'object') {
    visit(/** @type {Record<string, any>} */ (node));
    for (const value of Object.values(node)) walkSchema(value, visit);
  }
}

Feature('recursive-type expansion budget', () => {
  Scenario('a mutually-recursive node_modules metamodel is capped instead of exploding', () => {
    // Deep enough that unguarded expansion (2^13 = 8192 leaf paths) far
    // exceeds any sane per-conversion budget, so the cap is guaranteed to
    // engage. Pre-fix this scenario either OOMs or fully inlines the tree;
    // post-fix it completes fast and truncates beyond the budget.
    const DEPTH = 13;

    /** @type {Record<string, any>} */
    let doc;

    Given('a route whose response type reaches a large mutually-recursive metamodel imported from node_modules', async () => {
      const projectDir = await makeTmpDir('recursive-budget-');
      const pkgDir = path.join(projectDir, 'node_modules', 'metamodel-fixture');
      await mkdir(pkgDir, { recursive: true });

      await writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'metamodel-fixture', version: '1.0.0', types: 'index.d.ts' }, null, 2)
      );
      await writeFile(path.join(pkgDir, 'index.d.ts'), generateDiamond(DEPTH));

      const entryPath = path.join(projectDir, 'entry.js');
      await writeFile(
        entryPath,
        [
          "import express from 'express';",
          'export const app = express();',
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response<import('metamodel-fixture').N0>} res",
          ' */',
          'function getRoot(_req, res) {',
          '  res.json(/** @type {any} */ ({}));',
          '}',
          "app.get('/root', getRoot);",
          '',
        ].join('\n')
      );

      const tsconfigPath = path.join(projectDir, 'tsconfig.json');
      await writeFile(
        tsconfigPath,
        JSON.stringify(
          {
            include: ['entry.js'],
            compilerOptions: {
              allowJs: true,
              checkJs: true,
              module: 'nodenext',
              moduleResolution: 'nodenext',
            },
          },
          null,
          2
        )
      );

      const entryModule = await import(pathToFileURL(entryPath).href);
      doc = await buildSwaggerDocument(entryModule.app, { tsconfig: tsconfigPath });
    });

    Then('the GET /root 200 response body schema resolves to an object (the fixture actually reached the metamodel)', () => {
      const schema = doc.paths['/root'].get.responses['200'].content['application/json'].schema;
      expect(schema, 'response schema').to.be.an('object');
      expect(schema.type, 'root schema is an expanded object, not `any`/{}').to.equal('object');
      expect(schema.properties, 'root schema has the metamodel properties').to.include.keys('a', 'b');
    });

    And('total expanded object nodes stay bounded well below the unguarded 2^depth blowup', () => {
      const schema = doc.paths['/root'].get.responses['200'].content['application/json'].schema;
      let expanded = 0;
      walkSchema(schema, (obj) => {
        if (obj.type === 'object' && obj.properties) expanded += 1;
      });
      expect(expanded, `expanded object nodes (unguarded would be ~${2 ** DEPTH})`).to.be.at.most(6000);
    });

    And('expansion is truncated with opaque object stubs beyond the budget', () => {
      const schema = doc.paths['/root'].get.responses['200'].content['application/json'].schema;
      let stubs = 0;
      walkSchema(schema, (obj) => {
        if (obj.type === 'object' && !obj.properties && !('additionalProperties' in obj)) stubs += 1;
      });
      expect(stubs, 'at least one truncation stub emitted').to.be.greaterThan(0);
    });
  });
});
