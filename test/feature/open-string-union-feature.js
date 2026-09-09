import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import express from 'express';

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
 * Write a throwaway project whose `types.d.ts` holds the given declarations
 * and whose single route responds with the `Open` interface, then build the
 * swagger document for it.
 *
 * @param {string} prefix
 * @param {string[]} typeLines
 * @returns {Promise<Record<string, any>>}
 */
async function buildDocFor(prefix, typeLines) {
  const projectDir = await makeTmpDir(prefix);
  const typesPath = path.join(projectDir, 'types.d.ts');
  const routesPath = path.join(projectDir, 'routes.js');
  const tsconfigPath = path.join(projectDir, 'tsconfig.json');

  await writeFile(typesPath, [...typeLines, ''].join('\n'));

  await writeFile(
    routesPath,
    [
      "/** @typedef {import('./types.js').Open} Open */",
      '',
      '/**',
      " * @param {import('express').Request} _req",
      " * @param {import('express').Response<Open>} _res",
      ' */',
      'function getOpen(_req, _res) {}',
      '',
      "/** @param {import('express').Express} app */",
      'export function applyRoutes(app) {',
      "  app.get('/open', getOpen);",
      '}',
      '',
    ].join('\n')
  );

  await writeFile(
    tsconfigPath,
    JSON.stringify(
      {
        include: ['routes.js', 'types.d.ts'],
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          module: 'nodenext',
          moduleResolution: 'nodenext',
        },
      },
      null,
      2
    )
  );

  const routesModule = await import(pathToFileURL(routesPath).href);
  const app = express();
  routesModule.applyRoutes(app);
  return buildSwaggerDocument(app, { tsconfig: tsconfigPath });
}

Feature('Open string unions (the `Literal | (string & {})` idiom)', () => {
  Scenario('A property typed as `string & {}` is a plain string', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project whose response interface uses the `string & {}` autocomplete-preserving trick', async () => {
      doc = await buildDocFor('open-string-intersection-', ['export interface Open {', '  name: string & {};', '}']);
    });

    Then('the property schema is { type: "string" }', () => {
      expect(doc.components.schemas.Open.properties.name).to.deep.equal({ type: 'string' });
    });
  });

  Scenario('A union of string literals plus `string & {}` renders as "these values, or any string"', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project whose response interface declares an open string union', async () => {
      doc = await buildDocFor('open-string-union-', [
        'export type Country = "SE" | "NO" | "DK" | (string & {});',
        'export interface Open {',
        '  country: Country;',
        '  inline: "a" | "b" | (string & {});',
        '  mixed: "a" | 1 | (string & {});',
        '}',
      ]);
    });

    Then('the named union is a two-member anyOf: the literal enum and a plain string', () => {
      expect(doc.components.schemas.Country).to.deep.equal({
        anyOf: [{ type: 'string', enum: ['SE', 'NO', 'DK'] }, { type: 'string' }],
      });
    });

    And('an inline open union renders the same way', () => {
      expect(doc.components.schemas.Open.properties.inline).to.deep.equal({
        anyOf: [{ type: 'string', enum: ['a', 'b'] }, { type: 'string' }],
      });
    });

    And('a union mixing literal kinds still collapses its literals into one enum', () => {
      expect(doc.components.schemas.Open.properties.mixed).to.deep.equal({
        anyOf: [{ type: 'string', enum: ['a', '1'] }, { type: 'string' }],
      });
    });
  });
});
