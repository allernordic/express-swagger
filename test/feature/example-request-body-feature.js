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

Feature('@example JSDoc tag on a handler attaches a request body example', () => {
  Scenario('@example on a handler lands on requestBody.content[mediaType].example, accepting bare, fenced, and inline forms', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('an app whose handlers use different @example formatting variants', async () => {
      const projectDir = await makeTmpDir('example-request-body-');
      const typesPath = path.join(projectDir, 'types.d.ts');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(typesPath, ['export interface CreateUser { name: string; email: string }', ''].join('\n'));

      await writeFile(
        routesPath,
        [
          "/** @typedef {import('./types.js').CreateUser} CreateUser */",
          '',
          '/**',
          " * @param {import('express').Request<{}, unknown, CreateUser>} _req",
          " * @param {import('express').Response} _res",
          ' * @example',
          ' * { "name": "Acme", "email": "ops@acme.com" }',
          ' */',
          'function bareExample(_req, _res) {}',
          '',
          '/**',
          " * @param {import('express').Request<{}, unknown, CreateUser>} _req",
          " * @param {import('express').Response} _res",
          ' * @example',
          ' * ```json',
          ' * { "name": "Globex", "email": "hi@globex.test" }',
          ' * ```',
          ' */',
          'function fencedJsonExample(_req, _res) {}',
          '',
          '/**',
          " * @param {import('express').Request<{}, unknown, CreateUser>} _req",
          " * @param {import('express').Response} _res",
          ' * @example',
          ' * ```',
          ' * { "name": "Initech", "email": "bill@initech.test" }',
          ' * ```',
          ' */',
          'function fencedBareExample(_req, _res) {}',
          '',
          '/**',
          " * @param {import('express').Request<{}, unknown, CreateUser>} _req",
          " * @param {import('express').Response} _res",
          ' * @example `{ "name": "Hooli", "email": "ops@hooli.test" }`',
          ' */',
          'function inlineBacktickExample(_req, _res) {}',
          '',
          '/**',
          " * @param {import('express').Request<{}, unknown, CreateUser>} _req",
          " * @param {import('express').Response} _res",
          ' * @example',
          ' * ```json',
          ' * {',
          ' *   "name": "Stark",',
          ' *   "email": "tony@stark.test",',
          ' *   "address": {',
          ' *     "street": "10880 Malibu Point",',
          ' *     "city": "Malibu"',
          ' *   }',
          ' * }',
          ' * ```',
          ' */',
          'function multilineFencedExample(_req, _res) {}',
          '',
          '/**',
          " * @param {import('express').Request<{}, unknown, CreateUser>} _req",
          " * @param {import('express').Response} _res",
          ' * @example',
          ' * ```json',
          ' * { "name": "Wayne", "email": "bruce@wayne.test" }',
          ' * ```',
          ' * @tag users',
          ' */',
          'function fencedThenTagExample(_req, _res) {}',
          '',
          '/**',
          " * @param {import('express').Request<{}, unknown, CreateUser>} _req",
          " * @param {import('express').Response} _res",
          ' * @example { not valid json',
          ' */',
          'function malformedExample(_req, _res) {}',
          '',
          '/**',
          " * @param {import('express').Request<{}, unknown, CreateUser>} _req",
          " * @param {import('express').Response} _res",
          ' */',
          'function noExample(_req, _res) {}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.post('/bare', bareExample);",
          "  app.post('/fenced-json', fencedJsonExample);",
          "  app.post('/fenced-bare', fencedBareExample);",
          "  app.post('/inline-backtick', inlineBacktickExample);",
          "  app.post('/multiline-fenced', multilineFencedExample);",
          "  app.post('/fenced-then-tag', fencedThenTagExample);",
          "  app.post('/malformed', malformedExample);",
          "  app.post('/none', noExample);",
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

    Then('a bare-JSON @example lands as the request body example', () => {
      const content = doc.paths['/bare'].post.requestBody.content['application/json'];
      expect(content.example).to.deep.equal({ name: 'Acme', email: 'ops@acme.com' });
    });

    And('a ```json-fenced @example is unwrapped and parsed', () => {
      const content = doc.paths['/fenced-json'].post.requestBody.content['application/json'];
      expect(content.example).to.deep.equal({ name: 'Globex', email: 'hi@globex.test' });
    });

    And('a ```-fenced @example (no language tag) is unwrapped and parsed', () => {
      const content = doc.paths['/fenced-bare'].post.requestBody.content['application/json'];
      expect(content.example).to.deep.equal({ name: 'Initech', email: 'bill@initech.test' });
    });

    And('a single-backtick one-liner @example is unwrapped and parsed', () => {
      const content = doc.paths['/inline-backtick'].post.requestBody.content['application/json'];
      expect(content.example).to.deep.equal({ name: 'Hooli', email: 'ops@hooli.test' });
    });

    And('a multi-line formatted JSON inside a ```json fence is unwrapped and parsed', () => {
      const content = doc.paths['/multiline-fenced'].post.requestBody.content['application/json'];
      expect(content.example).to.deep.equal({
        name: 'Stark',
        email: 'tony@stark.test',
        address: { street: '10880 Malibu Point', city: 'Malibu' },
      });
    });

    And('an @example followed by another JSDoc tag is bounded by the next tag (both still apply)', () => {
      const op = doc.paths['/fenced-then-tag'].post;
      expect(op.requestBody.content['application/json'].example).to.deep.equal({
        name: 'Wayne',
        email: 'bruce@wayne.test',
      });
      expect(op.tags, '@tag users still emitted after the @example').to.deep.equal(['users']);
    });

    And('a malformed JSON @example is silently ignored (no example key emitted)', () => {
      const content = doc.paths['/malformed'].post.requestBody.content['application/json'];
      expect(content).to.not.have.property('example');
    });

    And('a handler without @example emits no example key', () => {
      const content = doc.paths['/none'].post.requestBody.content['application/json'];
      expect(content).to.not.have.property('example');
    });
  });
});
