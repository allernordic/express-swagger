import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express from 'express';
import openapiSchemaValidator from 'openapi-schema-validator';

import { buildSwaggerDocument } from '@aller/express-swagger';

const OpenAPISchemaValidator = openapiSchemaValidator.default ?? openapiSchemaValidator;
const FIXTURE_TSCONFIG = new URL('../../example/tsconfig.json', import.meta.url);
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
 * Create a unique temp directory under `./tmp` and remember it for `after`-hook cleanup.
 *
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function makeTmpDir(prefix) {
  const dir = await mkdtemp(path.join('./tmp', prefix));
  createdTmpDirs.push(dir);
  return dir;
}

Feature('buildSwaggerDocument programmatic API', () => {
  // ---------- Sunny-side ----------

  Scenario('an empty Express app produces a valid OpenAPI 3 document with no paths', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('buildSwaggerDocument is called on an Express app with no routes registered', async () => {
      const app = express();
      doc = await buildSwaggerDocument(app);
    });

    Then('the document is structurally valid OpenAPI 3', () => {
      const { errors } = new OpenAPISchemaValidator({ version: 3 }).validate(doc);
      expect(errors, `errors: ${JSON.stringify(errors, null, 2)}`).to.deep.equal([]);
    });

    And('the paths object is empty', () => {
      expect(doc.paths).to.deep.equal({});
    });

    And('info falls back to the default title and version', () => {
      expect(doc.info).to.deep.equal({ title: 'API', version: '0.0.0' });
    });

    And('no components section is emitted because no types were loaded', () => {
      expect(doc).to.not.have.property('components');
    });
  });

  Scenario('a single inline GET route is walked with a default 200 response', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('an Express app with GET /hello registered', async () => {
      const app = express();
      app.get('/hello', (_req, res) => res.json({ greeting: 'hi' }));
      doc = await buildSwaggerDocument(app);
    });

    Then('the document exposes /hello', () => {
      expect(doc.paths).to.have.property('/hello');
    });

    And('GET /hello has a 200 response with a generic-object body', () => {
      const op = doc.paths['/hello'].get;
      expect(op.responses, 'responses').to.have.property('200');
      expect(op.responses['200'].content['application/json'].schema).to.deep.equal({ type: 'object' });
    });
  });

  Scenario('multiple HTTP methods on the same path share a single path entry', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('an app with GET and POST registered on /items', async () => {
      const app = express();
      app.get('/items', (_req, res) => res.json([]));
      app.post('/items', (_req, res) => res.status(201).json({}));
      doc = await buildSwaggerDocument(app);
    });

    Then('both verbs appear under /items', () => {
      expect(doc.paths['/items']).to.have.all.keys('get', 'post');
    });

    And('each operation carries its own responses block', () => {
      expect(doc.paths['/items'].get.responses).to.have.property('200');
      expect(doc.paths['/items'].post.responses).to.have.property('200');
    });
  });

  Scenario('path parameters emit OpenAPI-style {name} parameters with a string default schema', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('an app with GET /widgets/:widgetId registered', async () => {
      const app = express();
      app.get('/widgets/:widgetId', (_req, res) => res.json({}));
      doc = await buildSwaggerDocument(app);
    });

    Then('the path key is /widgets/{widgetId}, not /widgets/:widgetId', () => {
      expect(doc.paths).to.have.property('/widgets/{widgetId}');
      expect(doc.paths).to.not.have.property('/widgets/:widgetId');
    });

    And('the widgetId parameter defaults to string because no params type was declared', () => {
      const params = doc.paths['/widgets/{widgetId}'].get.parameters;
      expect(params, 'parameters').to.be.an('array').with.lengthOf(1);
      expect(params[0]).to.include({ name: 'widgetId', in: 'path', required: true });
      expect(params[0].schema).to.deep.equal({ type: 'string' });
    });
  });

  Scenario('request bodies and success responses fall back to stubs when no tsconfig is passed', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('an app with POST /things and no tsconfig option', async () => {
      const app = express();
      app.post('/things', (_req, res) => res.json({}));
      doc = await buildSwaggerDocument(app);
    });

    Then('the request body schema is the generic-object stub', () => {
      const schema = doc.paths['/things'].post.requestBody.content['application/json'].schema;
      expect(schema).to.deep.equal({ type: 'object' });
    });

    And('the success status defaults to 200 (no method-based inference)', () => {
      expect(doc.paths['/things'].post.responses).to.have.property('200');
      expect(doc.paths['/things'].post.responses).to.not.have.property('201');
    });
  });

  // ---------- Things-go-wrong ----------

  Scenario('buildSwaggerDocument rejects when tsconfig points at a nonexistent file', () => {
    /** @type {Error | null} */
    let caught = null;

    Given('buildSwaggerDocument is called with a bogus tsconfig path', async () => {
      const app = express();
      const missing = path.join('./tmp', `missing-tsconfig-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      try {
        await buildSwaggerDocument(app, { tsconfig: missing });
      } catch (err) {
        caught = /** @type {Error} */ (err);
      }
    });

    Then('the call rejects with an Error', () => {
      expect(caught, 'caught error').to.be.an.instanceof(Error);
    });

    And('the error message mentions the missing configuration file', () => {
      expect(caught.message.toLowerCase()).to.match(/file|config|cannot|could not|enoent/);
    });
  });

  Scenario('buildSwaggerDocument rejects when tsconfig contains invalid JSON', () => {
    /** @type {Error | null} */
    let caught = null;

    Given('buildSwaggerDocument is called with a tsconfig that has a syntax error', async () => {
      const dir = await makeTmpDir('bad-tsconfig-');
      const bogus = path.join(dir, 'tsconfig.json');
      await writeFile(bogus, '{ this is not valid JSON');
      const app = express();
      try {
        await buildSwaggerDocument(app, { tsconfig: bogus });
      } catch (err) {
        caught = /** @type {Error} */ (err);
      }
    });

    Then('the call rejects with an Error', () => {
      expect(caught, 'caught error').to.be.an.instanceof(Error);
    });
  });

  Scenario('a RegExp route path is reported with a clear error naming the offending endpoint', () => {
    /** @type {Error | null} */
    let caught = null;

    Given('buildSwaggerDocument is called on an app whose route was registered with a RegExp path', async () => {
      const app = express();
      app.get(/\/legacy\/[0-9]+/, (_req, res) => res.json({}));
      try {
        await buildSwaggerDocument(app);
      } catch (err) {
        caught = /** @type {Error} */ (err);
      }
    });

    Then('the rejection is an Error', () => {
      expect(caught, 'caught error').to.be.an.instanceof(Error);
    });

    And('the error message identifies the offending route path', () => {
      expect(caught.message).to.match(/legacy/);
    });
  });

  Scenario('schemas declared in a path-aliased file outside `include` are still registered', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project where `#types` resolves via tsconfig.compilerOptions.paths to a types file outside the include pattern', async () => {
      const projectDir = await makeTmpDir('paths-demo-');
      const aliasedTypesPath = path.join(projectDir, 'aliased-types.d.ts');
      const entryPath = path.join(projectDir, 'entry.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(aliasedTypesPath, 'export interface AliasedThing { value: string; count: number }\n');
      // Register a route referencing AliasedThing so the prune walk keeps it
      // — the scenario's point is to verify path-alias resolution still finds
      // the type, not that orphan schemas survive.
      await writeFile(
        entryPath,
        [
          "/** @typedef {import('#types').AliasedThing} AliasedThing */",
          "import express from 'express';",
          'export const app = express();',
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response<AliasedThing>} _res",
          ' */',
          "app.get('/aliased', (_req, res) => res.json(/** @type {any} */ ({})));",
          '',
        ].join('\n')
      );
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
              paths: { '#types': ['./aliased-types.d.ts'] },
            },
          },
          null,
          2
        )
      );

      const entryModule = await import(pathToFileURL(entryPath).href);
      doc = await buildSwaggerDocument(entryModule.app, { tsconfig: tsconfigPath });
    });

    Then('AliasedThing appears in components.schemas', () => {
      expect(doc.components, 'components').to.be.an('object');
      expect(doc.components.schemas).to.have.property('AliasedThing');
      const schema = doc.components.schemas.AliasedThing;
      expect(schema.type).to.equal('object');
      expect(schema.properties).to.have.all.keys('value', 'count');
    });
  });

  Scenario('a path-aliased type used inline via `@param {Response<import(...)>}` is registered without any `@typedef`', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project whose routes.js uses `import("#types").Foo` inline in a handler JSDoc', async () => {
      const projectDir = await makeTmpDir('paths-inline-');
      const aliasedTypesPath = path.join(projectDir, 'aliased-types.d.ts');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(aliasedTypesPath, 'export interface Foo { value: string }\n');
      await writeFile(
        routesPath,
        [
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response<import('#types').Foo>} res",
          ' */',
          'function getFoo(_req, res) {',
          '  res.status(200).json(/** @type {any} */ ({}));',
          '}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.get('/foo', getFoo);",
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify(
          {
            include: ['routes.js'],
            compilerOptions: {
              allowJs: true,
              checkJs: false,
              module: 'nodenext',
              moduleResolution: 'nodenext',
              paths: { '#types': ['./aliased-types.d.ts'] },
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

    Then('Foo appears in components.schemas', () => {
      expect(doc.components?.schemas).to.have.property('Foo');
      expect(doc.components.schemas.Foo.properties).to.have.property('value');
    });

    And('GET /foo 200 response refs Foo', () => {
      const schema = doc.paths['/foo'].get.responses['200'].content['application/json'].schema;
      expect(schema).to.deep.equal({ $ref: '#/components/schemas/Foo' });
    });
  });

  Scenario(
    'a `@param {Request<…>}` whose import path is not `express` is ignored, and the route falls back to a generic representation',
    () => {
      /** @type {Record<string, any>} */
      let doc;

      Given('a project where Request comes from a non-express module', async () => {
        const projectDir = await makeTmpDir('non-express-request-');
        const localTypesPath = path.join(projectDir, 'local-types.d.ts');
        const routesPath = path.join(projectDir, 'routes.js');
        const tsconfigPath = path.join(projectDir, 'tsconfig.json');

        // A locally-declared `Request` that has nothing to do with Express. If the
        // library blindly trusted the identifier name it'd slurp `BodyShape` as the
        // request body schema; the safeguard should ignore the @param entirely.
        await writeFile(
          localTypesPath,
          ['export interface Request<P, R, B> {', '  custom: { params: P; res: R; body: B };', '}', ''].join('\n')
        );
        await writeFile(
          routesPath,
          [
            '/** @typedef {{ shouldNotAppear: string }} BodyShape */',
            '',
            '/**',
            " * @param {import('./local-types.js').Request<{}, unknown, BodyShape>} _req",
            " * @param {import('express').Response} _res",
            ' */',
            'function postWidget(_req, _res) {}',
            '',
            "/** @param {import('express').Express} app */",
            'export function applyRoutes(app) {',
            "  app.post('/widgets', postWidget);",
            '}',
            '',
          ].join('\n')
        );
        await writeFile(
          tsconfigPath,
          JSON.stringify(
            {
              include: ['routes.js'],
              compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
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

      Then('POST /widgets is still in the doc', () => {
        expect(doc.paths['/widgets']).to.have.property('post');
      });

      And('the request body schema is the generic-object stub, not a $ref the locally-declared Request would have produced', () => {
        const schema = doc.paths['/widgets'].post.requestBody.content['application/json'].schema;
        expect(schema).to.deep.equal({ type: 'object' });
        expect(schema).to.not.have.property('$ref');
      });
    }
  );

  Scenario('a `Request<…, UnresolvedReqBody>` whose body type is not registered falls back to an empty request body schema', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project whose request body type is named but undeclared', async () => {
      const projectDir = await makeTmpDir('unresolved-reqbody-');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        routesPath,
        [
          '/**',
          " * @param {import('express').Request<{}, unknown, UnresolvedReqBody>} _req",
          " * @param {import('express').Response} _res",
          ' */',
          'function postThing(_req, _res) {}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.post('/things', postThing);",
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['routes.js'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then('POST /things requestBody emits an empty schema (matches anything)', () => {
      const schema = doc.paths['/things'].post.requestBody.content['application/json'].schema;
      expect(schema).to.deep.equal({});
    });
  });

  Scenario('a route path computed via `dynamic || "fallback"` is recognized as the literal fallback', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project whose route registration uses `options?.basePath || "/widgets"`', async () => {
      const projectDir = await makeTmpDir('logical-or-path-');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        routesPath,
        [
          "/** @param {import('express').Express} app */",
          '/** @param {{ basePath?: string }} [options] */',
          'export function applyRoutes(app, options) {',
          "  const basePath = options?.basePath || '/widgets';",
          '  app.get(',
          '    basePath,',
          '    /**',
          "     * @param {import('express').Request} _req",
          "     * @param {import('express').Response} _res",
          '     * @tag widgets-dynamic-path',
          '     */',
          '    (_req, res) => res.json({})',
          '  );',
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['routes.js'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then('GET /widgets surfaces in the doc', () => {
      expect(doc.paths).to.have.property('/widgets');
      expect(doc.paths['/widgets']).to.have.property('get');
    });

    And("the route's JSDoc metadata is attached (proving matchRouteCall resolved the LogicalExpression path)", () => {
      const op = doc.paths['/widgets'].get;
      expect(op.tags, '@tag should have been picked up').to.deep.equal(['widgets-dynamic-path']);
    });
  });

  Scenario('`.bind(thisArg)`-wrapped handlers (both `fn.bind(…)` and `obj.method.bind(…)`) have their JSDoc picked up', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project that registers routes via `.bind` wrappers', async () => {
      const projectDir = await makeTmpDir('bind-wrapped-handler-');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        routesPath,
        [
          'class Middleware {',
          '  /**',
          "   * @param {import('express').Request} _req",
          "   * @param {import('express').Response} _res",
          '   * @tag method-bound',
          '   */',
          '  handle(_req, _res) {}',
          '}',
          '',
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response} _res",
          ' * @tag fn-bound',
          ' */',
          'function freeHandler(_req, _res) {}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          '  const middleware = new Middleware();',
          "  app.get('/bound-method', middleware.handle.bind(middleware));",
          "  app.get('/bound-fn', freeHandler.bind(null));",
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['routes.js'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then("`.bind`-wrapped class method's `@tag` shows up on GET /bound-method", () => {
      const op = doc.paths['/bound-method'].get;
      expect(op.tags, '@tag should resolve through obj.method.bind(…)').to.deep.equal(['method-bound']);
    });

    And("`.bind`-wrapped free function's `@tag` shows up on GET /bound-fn", () => {
      const op = doc.paths['/bound-fn'].get;
      expect(op.tags, '@tag should resolve through fn.bind(…)').to.deep.equal(['fn-bound']);
    });
  });

  Scenario('components.schemas drops unreferenced types and keeps transitive dependencies', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project with a referenced root type (transitively composing another) and an unreferenced sibling', async () => {
      const projectDir = await makeTmpDir('schema-prune-');
      const typesPath = path.join(projectDir, 'types.d.ts');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      // UserRecord composes BaseUser via a property — emitted as a $ref in the
      // schema body, which the prune walk follows. (Interface inheritance is
      // INLINED, not $ref'd, so it would not pull a base type through the prune.)
      await writeFile(
        typesPath,
        [
          'export interface BaseUser {',
          '  id: string;',
          '}',
          'export interface UserRecord {',
          '  base: BaseUser;',
          '  name: string;',
          '}',
          'export interface UnusedThing {',
          '  irrelevant: string;',
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        routesPath,
        [
          "/** @typedef {import('./types.js').UserRecord} UserRecord */",
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          '  app.get(',
          "    '/u',",
          '    /**',
          "     * @param {import('express').Request} _req",
          "     * @param {import('express').Response<UserRecord>} _res",
          '     */',
          '    (_req, res) => res.json(/** @type {any} */ ({}))',
          '  );',
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['**/*'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then('UserRecord is in components.schemas (referenced by GET /u)', () => {
      expect(doc.components.schemas).to.have.property('UserRecord');
    });

    And('BaseUser is kept (UserRecord composes it via $ref)', () => {
      expect(doc.components.schemas).to.have.property('BaseUser');
    });

    And('UnusedThing is dropped (no operation reaches it)', () => {
      expect(doc.components.schemas).to.not.have.property('UnusedThing');
    });
  });

  Scenario('a duplicate `app.METHOD(path, …)` registration emits a single operation (last declaration wins) and warns', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('an app that registers POST /duplicate twice', async () => {
      const app = express();
      app.post('/duplicate', (_req, res) => res.json({ first: true }));
      app.post('/duplicate', (_req, res) => res.json({ second: true }));
      doc = await buildSwaggerDocument(app);
    });

    Then('only one POST /duplicate operation appears in the doc', () => {
      expect(doc.paths['/duplicate'], 'paths').to.have.property('post');
      expect(Object.keys(doc.paths['/duplicate'])).to.deep.equal(['post']);
    });
  });

  Scenario('TS utility wrappers (`Promise<T>` / `Awaited<T>` / `NonNullable<T>`) are peeled before resolving the slot identifier', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project where the response body is wrapped in a TS utility type', async () => {
      const projectDir = await makeTmpDir('utility-wrapper-');
      const typesPath = path.join(projectDir, 'types.d.ts');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(typesPath, ['export interface UserRecord { id: string; name: string; }', ''].join('\n'));
      await writeFile(
        routesPath,
        [
          "/** @typedef {import('./types.js').UserRecord} UserRecord */",
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          '  app.get(',
          "    '/promised',",
          '    /**',
          "     * @param {import('express').Request} _req",
          "     * @param {import('express').Response<Promise<UserRecord>>} _res",
          '     */',
          '    (_req, res) => res.json(/** @type {any} */ ({}))',
          '  );',
          '  app.get(',
          "    '/awaited-nonnullable',",
          '    /**',
          "     * @param {import('express').Request} _req",
          "     * @param {import('express').Response<Awaited<NonNullable<UserRecord>>>} _res",
          '     */',
          '    (_req, res) => res.json(/** @type {any} */ ({}))',
          '  );',
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['**/*'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then('GET /promised emits a $ref to UserRecord (Promise wrapper peeled)', () => {
      const schema = doc.paths['/promised'].get.responses['200'].content['application/json'].schema;
      expect(schema).to.deep.equal({ $ref: '#/components/schemas/UserRecord' });
    });

    And('GET /awaited-nonnullable peels both wrappers down to the named UserRecord schema', () => {
      const schema = doc.paths['/awaited-nonnullable'].get.responses['200'].content['application/json'].schema;
      expect(schema).to.deep.equal({ $ref: '#/components/schemas/UserRecord' });
    });
  });

  Scenario('a JS prototype-assigned handler (`Class.prototype.method = function () {}`) has its JSDoc picked up', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project that registers a prototype-assigned method via `.bind`', async () => {
      const projectDir = await makeTmpDir('prototype-assigned-handler-');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        routesPath,
        [
          'function Middleware() {}',
          '',
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response} _res",
          ' * @tag prototype-assigned',
          ' */',
          'Middleware.prototype.handle = function handle(_req, _res) {};',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          '  const middleware = new Middleware();',
          "  app.get('/proto-bound', middleware.handle.bind(middleware));",
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['routes.js'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then("the prototype-assigned handler's `@tag` shows up on GET /proto-bound", () => {
      const op = doc.paths['/proto-bound'].get;
      expect(op.tags, '@tag should resolve through Class.prototype.method assignment').to.deep.equal(['prototype-assigned']);
    });
  });

  Scenario("a handler imported from another module (`import { handler } from './…'`) has its JSDoc picked up", () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project that registers an imported named handler', async () => {
      const projectDir = await makeTmpDir('imported-handler-');
      const handlerPath = path.join(projectDir, 'handlers.js');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        handlerPath,
        [
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response} _res",
          ' * @tag imported',
          ' */',
          'export function importedHandler(_req, _res) {}',
          '',
        ].join('\n')
      );
      await writeFile(
        routesPath,
        [
          "import { importedHandler } from './handlers.js';",
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.get('/imported', importedHandler);",
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['**/*.js'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then("the imported handler's `@tag` shows up on GET /imported", () => {
      const op = doc.paths['/imported'].get;
      expect(op.tags, '@tag should resolve through the import alias').to.deep.equal(['imported']);
    });
  });

  Scenario("a named handler passed to a factory wrapper (`app.get('/x', factory(handler))`) has its JSDoc picked up", () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project that registers a route via a factory wrapping a named handler', async () => {
      const projectDir = await makeTmpDir('factory-named-handler-');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        routesPath,
        [
          "/** @param {import('express').Request[]} _handlers */",
          'function wrap(..._handlers) { return (_req, res) => res.json({}); }',
          '',
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response} _res",
          ' * @tag wrapped',
          ' */',
          'function namedHandler(_req, _res) {}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.get('/wrapped', wrap(namedHandler));",
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['routes.js'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then("the wrapped namedHandler's `@tag` shows up on GET /wrapped", () => {
      const op = doc.paths['/wrapped'].get;
      expect(op.tags, '@tag should resolve through the factory call').to.deep.equal(['wrapped']);
    });
  });

  Scenario('a `Response<UnresolvedName>` that is not registered anywhere falls back to an empty schema', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a project whose response type is named but undeclared', async () => {
      const projectDir = await makeTmpDir('unresolved-resbody-');
      const routesPath = path.join(projectDir, 'routes.js');
      const tsconfigPath = path.join(projectDir, 'tsconfig.json');

      await writeFile(
        routesPath,
        [
          '/**',
          " * @param {import('express').Request} _req",
          " * @param {import('express').Response<UnresolvedTypo>} _res",
          ' */',
          'function getThing(_req, _res) {}',
          '',
          "/** @param {import('express').Express} app */",
          'export function applyRoutes(app) {',
          "  app.get('/things/:id', getThing);",
          '}',
          '',
        ].join('\n')
      );
      await writeFile(
        tsconfigPath,
        JSON.stringify({
          include: ['routes.js'],
          compilerOptions: { allowJs: true, checkJs: false, module: 'nodenext', moduleResolution: 'nodenext' },
        })
      );

      const routesModule = await import(pathToFileURL(routesPath).href);
      const app = express();
      routesModule.applyRoutes(app);
      doc = await buildSwaggerDocument(app, { tsconfig: tsconfigPath });
    });

    Then('GET /things/{id} 200 emits an empty schema (matches anything)', () => {
      const schema = doc.paths['/things/{id}'].get.responses['200'].content['application/json'].schema;
      expect(schema).to.deep.equal({});
    });
  });

  Scenario('a URL tsconfig reference resolves the same as a string path', () => {
    /** @type {Record<string, any>} */
    let fromString;
    /** @type {Record<string, any>} */
    let fromUrl;

    Given('buildSwaggerDocument is called with the fixture tsconfig once as a string and once as a URL', async () => {
      const app1 = express();
      app1.get('/x', (_req, res) => res.json({}));
      const app2 = express();
      app2.get('/x', (_req, res) => res.json({}));

      fromString = await buildSwaggerDocument(app1, { tsconfig: fileURLToPath(FIXTURE_TSCONFIG) });
      fromUrl = await buildSwaggerDocument(app2, { tsconfig: FIXTURE_TSCONFIG });
    });

    Then('both forms produce equivalent documents', () => {
      expect(fromString.info).to.deep.equal(fromUrl.info);
      expect(Object.keys(fromString.paths).sort()).to.deep.equal(Object.keys(fromUrl.paths).sort());
      expect(Object.keys(fromString.components?.schemas ?? {}).sort()).to.deep.equal(Object.keys(fromUrl.components?.schemas ?? {}).sort());
    });
  });
});
