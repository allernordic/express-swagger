import { exec as execCb } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execCb);

const CLI_PATH = fileURLToPath(new URL('../../bin/express-swagger.js', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** @type {string[]} */
const createdRepoTmpDirs = [];

after(async () => {
  await Promise.all(createdRepoTmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  createdRepoTmpDirs.length = 0;
});

Feature('express-swagger CLI', () => {
  Scenario('pre-building with --tsconfig defaulting to the closest tsconfig next to the app module', () => {
    /** @type {string} */
    let outputPath;
    /** @type {string} */
    let raw;
    /** @type {Record<string, any>} */
    let doc;

    Given('the CLI is run against the fixture app without passing --tsconfig', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'express-swagger-cli-'));
      outputPath = path.join(dir, 'out.json');
      await exec(`node "${CLI_PATH}" example/index.js --out "${outputPath}"`, { cwd: PROJECT_ROOT });
      raw = await readFile(outputPath, 'utf8');
      doc = JSON.parse(raw);
    });

    Then('the doc includes schemas derived from the auto-discovered tsconfig', () => {
      expect(doc.components?.schemas, 'components.schemas').to.be.an('object');
      expect(doc.components.schemas).to.include.all.keys(
        'CreateUserRequest',
        'CreateUserResponse',
        'LoginRequest',
        'LoginResponse',
        'ErrorResponseBody'
      );
    });

    And('the doc has all fixture routes', () => {
      expect(doc.paths).to.include.all.keys('/users', '/users/{id}', '/login');
    });

    And('the doc exposes DELETE /users/{id} with a 204 response', () => {
      expect(doc.paths['/users/{id}']).to.have.property('delete');
      expect(doc.paths['/users/{id}'].delete.responses).to.have.property('204');
    });

    And('the default output is indented with two spaces', () => {
      expect(raw).to.match(/\n {2}"openapi"/, 'expected two-space indentation');
      expect(raw.split('\n').length).to.be.greaterThan(10);
    });
  });

  Scenario('--out creates any missing parent directories on the way to the output file', () => {
    /** @type {string} */
    let rootDir;
    /** @type {string} */
    let outputPath;

    Given('the CLI is run with --out pointing at a nested path whose parents do not exist', async () => {
      rootDir = await mkdtemp(path.join(tmpdir(), 'express-swagger-cli-'));
      outputPath = path.join(rootDir, 'nested', 'deeper', 'out.json');
      // Sanity: make sure the nested parents really don't exist yet — otherwise the assertion is vacuous.
      await rm(path.join(rootDir, 'nested'), { recursive: true, force: true });
      await exec(`node "${CLI_PATH}" example/index.js --out "${outputPath}"`, { cwd: PROJECT_ROOT });
    });

    Then('the file is written at the requested path', async () => {
      const raw = await readFile(outputPath, 'utf8');
      const doc = JSON.parse(raw);
      expect(doc.paths, 'paths').to.include.all.keys('/users', '/users/{id}', '/login');
    });
  });

  Scenario('--out target is pre-created so the app module can statically import it', () => {
    /** @type {string} */
    let outputPath;
    /** @type {string} */
    let raw;

    Given('an app module that statically imports its (yet-to-be-built) swagger.json on load', async () => {
      // Stage under the repo's `./tmp/` so node can resolve `express` from the workspace's node_modules.
      const projectRoot = await mkdtemp(path.join(PROJECT_ROOT, 'tmp', 'cli-prebuilt-'));
      createdRepoTmpDirs.push(projectRoot);
      outputPath = path.join(projectRoot, 'public', 'swagger.json');

      // app.js imports the not-yet-built JSON file at module-load time.
      const appPath = path.join(projectRoot, 'app.js');
      const appSource = [
        "import express from 'express';",
        "import doc from './public/swagger.json' with { type: 'json' };",
        '',
        'export function setupApp() {',
        '  const app = express();',
        "  app.get('/echo-doc-version', (_req, res) => res.json({ version: doc.info?.version }));",
        '  return app;',
        '}',
        '',
      ].join('\n');
      await writeFile(appPath, appSource);

      // Minimal package.json so node treats `app.js` as ESM and resolves `express` from the parent workspace.
      await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'cli-prebuilt-fixture', type: 'module' }));

      await exec(`node "${CLI_PATH}" "${appPath}" --out "${outputPath}"`, { cwd: PROJECT_ROOT });
      raw = await readFile(outputPath, 'utf8');
    });

    Then('the CLI completes and writes a valid OpenAPI document', () => {
      const doc = JSON.parse(raw);
      expect(doc.openapi).to.equal('3.0.0');
      expect(doc.paths).to.have.property('/echo-doc-version');
    });
  });

  Scenario('--minify writes the document on a single line', () => {
    /** @type {string} */
    let raw;

    Given('the CLI is run with --minify', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'express-swagger-cli-'));
      const outputPath = path.join(dir, 'out.json');
      await exec(`node "${CLI_PATH}" example/index.js --out "${outputPath}" --minify`, { cwd: PROJECT_ROOT });
      raw = await readFile(outputPath, 'utf8');
    });

    Then('the output contains no newlines and no indentation', () => {
      expect(raw).to.not.match(/\n/);
      expect(raw).to.not.match(/ {2}/);
    });

    And('the output is still valid JSON describing the fixture routes', () => {
      const doc = JSON.parse(raw);
      expect(doc.paths).to.include.all.keys('/users', '/users/{id}', '/login');
    });
  });
});
