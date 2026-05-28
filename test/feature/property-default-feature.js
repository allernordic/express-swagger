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

Feature('@default JSDoc tag on a schema property', () => {
  Scenario('A property tagged with @default emits the value as OpenAPI default', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project whose response interface declares @default on several properties', async () => {
      const projectDir = await makeTmpDir('property-default-');
      const typesPath = path.join(projectDir, 'types.d.ts');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        typesPath,
        [
          'export interface Result {',
          '  /**',
          '   * Whether the operation completed without errors.',
          '   * @default false',
          '   */',
          '  ok: boolean;',
          '  /**',
          '   * @default true',
          '   */',
          '  verbose: boolean;',
          '  /**',
          '   * @default 10',
          '   */',
          '  retries: number;',
          '  /**',
          '   * @default "pending"',
          '   */',
          '  status: string;',
          '}',
          '',
        ].join('\n')
      );

      await writeFile(
        routesPath,
        [
          "/** @typedef {import('./types.js').Result} Result */",
          '',
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response<Result>} _res",
          ' */',
          'function getResult(_req, _res) {}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.get('/result', getResult);",
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
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then('Result is registered as a named schema', () => {
      expect(doc.components?.schemas).to.have.property('Result');
    });

    And('the boolean property tagged @default false emits default: false', () => {
      const okSchema = doc.components.schemas.Result.properties.ok;
      expect(okSchema.type).to.equal('boolean');
      expect(okSchema.default).to.equal(false);
    });

    And('the boolean property tagged @default true emits default: true', () => {
      const verboseSchema = doc.components.schemas.Result.properties.verbose;
      expect(verboseSchema.type).to.equal('boolean');
      expect(verboseSchema.default).to.equal(true);
    });

    And('the numeric property tagged @default 10 emits default: 10', () => {
      const retriesSchema = doc.components.schemas.Result.properties.retries;
      expect(retriesSchema.type).to.equal('number');
      expect(retriesSchema.default).to.equal(10);
    });

    And('the string property tagged @default "pending" emits default: "pending"', () => {
      const statusSchema = doc.components.schemas.Result.properties.status;
      expect(statusSchema.type).to.equal('string');
      expect(statusSchema.default).to.equal('pending');
    });

    And('the leading JSDoc description is still preserved alongside the default', () => {
      const okSchema = doc.components.schemas.Result.properties.ok;
      expect(okSchema.description).to.equal('Whether the operation completed without errors.');
    });
  });
});
