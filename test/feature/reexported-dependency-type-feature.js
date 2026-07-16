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

Feature("A dependency's type re-exported from a project file becomes a shared component", () => {
  Scenario('`export type { T } from <dep>` registers T under #/components/schemas and use sites emit a $ref', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project that re-exports an enum-like type alias from a node_modules dependency', async () => {
      const projectDir = await makeTmpDir('reexported-dependency-type-');
      const depDir = path.join(projectDir, 'node_modules', 'fake-dep');
      await mkdir(depDir, { recursive: true });

      await writeFile(
        path.join(depDir, 'package.json'),
        JSON.stringify({ name: 'fake-dep', version: '1.0.0', types: './index.d.ts', exports: { '.': { types: './index.d.ts' } } })
      );
      await writeFile(path.join(depDir, 'index.d.ts'), ["export type ActivityStatus = 'idle' | 'entered' | 'started';", ''].join('\n'));

      // The re-export form the README warns about — a genuine dependency type
      // surfaced by name from a project file.
      await writeFile(path.join(projectDir, 'types.d.ts'), ["export type { ActivityStatus } from 'fake-dep';", ''].join('\n'));

      await writeFile(
        path.join(projectDir, 'routes.js'),
        [
          "/** @typedef {{ activityStatus: import('./types.js').ActivityStatus }} Activity */",
          '',
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response<Activity>} _res",
          ' */',
          'function getActivity(_req, _res) {}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.get('/activity', getActivity);",
          '}',
          '',
        ].join('\n')
      );

      await writeFile(
        path.join(projectDir, 'tsconfig.json'),
        JSON.stringify({
          include: ['routes.js', 'types.d.ts'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(path.join(projectDir, 'routes.js')).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: path.join(projectDir, 'tsconfig.json') });
    });

    Then('the re-exported type is a shared component schema', () => {
      expect(doc.components.schemas.ActivityStatus).to.deep.equal({ type: 'string', enum: ['idle', 'entered', 'started'] });
    });

    And('a property of that type resolves to a single $ref instead of an inline enum', () => {
      expect(doc.components.schemas.Activity.properties.activityStatus).to.deep.equal({
        $ref: '#/components/schemas/ActivityStatus',
      });
    });
  });
});
