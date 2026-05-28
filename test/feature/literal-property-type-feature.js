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

Feature('Literal-type properties emit enum schemas', () => {
  Scenario('A property typed as a single literal value (string, number, or boolean) emits enum: [value]', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project whose response interface pins properties to literal types', async () => {
      const projectDir = await makeTmpDir('literal-property-type-');
      const typesPath = path.join(projectDir, 'types.d.ts');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        typesPath,
        ['export interface Pinned {', '  status: "pending";', '  code: 200;', '  ok: false;', '  shouted: true;', '}', ''].join('\n')
      );

      await writeFile(
        routesPath,
        [
          "/** @typedef {import('./types.js').Pinned} Pinned */",
          '',
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response<Pinned>} _res",
          ' */',
          'function getPinned(_req, _res) {}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.get('/pinned', getPinned);",
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

    Then('the string-literal property emits { type: string, enum: ["pending"] }', () => {
      expect(doc.components.schemas.Pinned.properties.status).to.deep.equal({ type: 'string', enum: ['pending'] });
    });

    And('the number-literal property emits { type: number, enum: [200] }', () => {
      expect(doc.components.schemas.Pinned.properties.code).to.deep.equal({ type: 'number', enum: [200] });
    });

    And('a property typed as the literal false emits { type: boolean, enum: [false] }', () => {
      expect(doc.components.schemas.Pinned.properties.ok).to.deep.equal({ type: 'boolean', enum: [false] });
    });

    And('a property typed as the literal true emits { type: boolean, enum: [true] }', () => {
      expect(doc.components.schemas.Pinned.properties.shouted).to.deep.equal({ type: 'boolean', enum: [true] });
    });
  });
});
