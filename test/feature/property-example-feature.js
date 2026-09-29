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
 * @param {string[]} typesLines
 * @param {string} typeName
 * @param {string[]} [handlerDocLines]
 * @returns {Promise<Record<string, any>>}
 */
async function buildDocForType(prefix, typesLines, typeName, handlerDocLines = []) {
  const projectDir = await mkdtemp(path.join('./tmp', prefix));
  createdTmpDirs.push(projectDir);
  const typesPath = path.join(projectDir, 'types.d.ts');
  const routesPath = path.join(projectDir, 'routes.js');
  const tsconfigPath = path.join(projectDir, 'tsconfig.json');

  await writeFile(typesPath, [...typesLines, ''].join('\n'));

  await writeFile(
    routesPath,
    [
      `/** @typedef {import('./types.js').${typeName}} ${typeName} */`,
      '',
      '/**',
      ...handlerDocLines.map((line) => ` * ${line}`),
      ` * @param {import('express').Request<{}, any, ${typeName}>} _req`,
      " * @param {import('express').Response} _res",
      ' */',
      'function handler(_req, _res) {}',
      '',
      "/** @param {import('express').Express} app */",
      'export function applyRoutes(app) {',
      "  app.post('/subject', handler);",
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

Feature('@example JSDoc tag on a schema property', () => {
  Scenario('A string property tagged with a quoted @example emits it as OpenAPI example', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a request body interface with a described string property tagged @example', async () => {
      doc = await buildDocForType(
        'property-example-string-',
        [
          'export interface NewsletterSignupBody {',
          '  /**',
          '   * Signup source, e.g. client site url',
          '   * @example "https://elle.se"',
          '   */',
          '  source: string;',
          '  email: string;',
          '}',
        ],
        'NewsletterSignupBody'
      );
    });

    Then('the property emits the example alongside its type and description', () => {
      expect(doc.components.schemas.NewsletterSignupBody.properties.source).to.deep.equal({
        type: 'string',
        description: 'Signup source, e.g. client site url',
        example: 'https://elle.se',
      });
    });

    And('a property without @example is left untouched', () => {
      expect(doc.components.schemas.NewsletterSignupBody.properties.email).to.deep.equal({ type: 'string' });
    });
  });

  Scenario('An unquoted @example is used verbatim on string-typed properties only', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('an interface with bare-word @example values on a string, a string enum and a number', async () => {
      doc = await buildDocForType(
        'property-example-bare-',
        [
          'export interface Signup {',
          '  /** @example https://elle.se */',
          '  source: string;',
          '  /** @example sv */',
          '  language: "sv" | "en";',
          '  /** @example many */',
          '  count: number;',
          '}',
        ],
        'Signup'
      );
    });

    Then('the string property emits the bare text as example', () => {
      expect(doc.components.schemas.Signup.properties.source).to.deep.equal({ type: 'string', example: 'https://elle.se' });
    });

    And('the string enum property emits the bare text as example', () => {
      expect(doc.components.schemas.Signup.properties.language.example).to.equal('sv');
    });

    And('the number property drops the unparsable example', () => {
      expect(doc.components.schemas.Signup.properties.count).to.deep.equal({ type: 'number' });
    });
  });

  Scenario('JSON @example values keep their type', () => {
    /** @type {Record<string, any>} */
    let props;

    Given('an interface with JSON @example values of several types', async () => {
      const doc = await buildDocForType(
        'property-example-json-',
        [
          'export interface Filters {',
          '  /** @example 10 */',
          '  limit: number;',
          '  /** @example false */',
          '  archived: boolean;',
          '  /** @example null */',
          '  cursor: string | null;',
          '  /** @example ["A", "B"] */',
          '  tags: string[];',
          '  /** @example { "from": "2026-01-01" } */',
          '  range: { from: string };',
          '}',
        ],
        'Filters'
      );
      props = doc.components.schemas.Filters.properties;
    });

    Then('the number example stays a number', () => {
      expect(props.limit.example).to.equal(10);
    });

    And('the boolean false example is kept', () => {
      expect(props.archived).to.have.property('example', false);
    });

    And('the null example is kept', () => {
      expect(props.cursor).to.have.property('example', null);
    });

    And('the array example stays an array', () => {
      expect(props.tags.example).to.deep.equal(['A', 'B']);
    });

    And('the object example stays an object', () => {
      expect(props.range.example).to.deep.equal({ from: '2026-01-01' });
    });
  });

  Scenario('A fenced multi-line @example object is parsed', () => {
    /** @type {Record<string, any>} */
    let props;

    Given('an interface property with a fenced multi-line JSON @example', async () => {
      const doc = await buildDocForType(
        'property-example-fenced-',
        [
          'export interface Profile {',
          '  /**',
          '   * Postal address',
          '   * @example',
          '   * ```json',
          '   * {',
          '   *   "street": "Main 1",',
          '   *   "city": "Oslo"',
          '   * }',
          '   * ```',
          '   */',
          '  address: { street: string; city: string };',
          '}',
        ],
        'Profile'
      );
      props = doc.components.schemas.Profile.properties;
    });

    Then('the example is the parsed object', () => {
      expect(props.address.example).to.deep.equal({ street: 'Main 1', city: 'Oslo' });
    });

    And('the example text does not leak into the description', () => {
      expect(props.address.description).to.equal('Postal address');
    });
  });

  Scenario('Only the first @example tag on a property counts', () => {
    /** @type {Record<string, any>} */
    let props;

    Given('an interface property with two @example tags', async () => {
      const doc = await buildDocForType(
        'property-example-first-',
        ['export interface Paging {', '  /**', '   * @example 1', '   * @example 2', '   */', '  page: number;', '}'],
        'Paging'
      );
      props = doc.components.schemas.Paging.properties;
    });

    Then('the first example wins', () => {
      expect(props.page).to.deep.equal({ type: 'number', example: 1 });
    });
  });

  Scenario('An empty @example tag is ignored', () => {
    /** @type {Record<string, any>} */
    let props;

    Given('an interface string property with an @example tag but no value', async () => {
      const doc = await buildDocForType(
        'property-example-empty-',
        ['export interface Note {', '  /**', '   * Free text', '   * @example', '   */', '  text: string;', '}'],
        'Note'
      );
      props = doc.components.schemas.Note.properties;
    });

    Then('no example keyword is emitted', () => {
      expect(props.text).to.deep.equal({ type: 'string', description: 'Free text' });
    });
  });

  Scenario('@example together with @default and on $ref properties', () => {
    /** @type {Record<string, any>} */
    let props;

    Given('an interface with a property tagged both @default and @example, and a $ref property tagged @example', async () => {
      const doc = await buildDocForType(
        'property-example-ref-',
        [
          'export interface Address {',
          '  city: string;',
          '}',
          '',
          'export interface Order {',
          '  /**',
          '   * Items per page',
          '   * @default 20',
          '   * @example 50',
          '   */',
          '  pageSize: number;',
          '  /**',
          '   * Delivery address',
          '   * @default { "city": "Stockholm" }',
          '   * @example { "city": "Oslo" }',
          '   */',
          '  shipTo: Address;',
          '  /** @example { "city": "Bergen" } */',
          '  billTo: Address;',
          '}',
        ],
        'Order'
      );
      props = doc.components.schemas.Order.properties;
    });

    Then('a property with both tags emits both default and example', () => {
      expect(props.pageSize).to.deep.equal({ type: 'number', description: 'Items per page', default: 20, example: 50 });
    });

    And('a $ref property wraps the reference in allOf next to description, default and example', () => {
      expect(props.shipTo).to.deep.equal({
        description: 'Delivery address',
        allOf: [{ $ref: '#/components/schemas/Address' }],
        default: { city: 'Stockholm' },
        example: { city: 'Oslo' },
      });
    });

    And('a $ref property with only @example is wrapped in allOf', () => {
      expect(props.billTo).to.deep.equal({
        allOf: [{ $ref: '#/components/schemas/Address' }],
        example: { city: 'Bergen' },
      });
    });
  });

  Scenario('A route-level @example overrides property examples for that request body', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('a handler with a whole-body @example whose body type has property examples', async () => {
      doc = await buildDocForType(
        'property-example-route-',
        ['export interface Signup {', '  /** @example "https://elle.se" */', '  source: string;', '}'],
        'Signup',
        ['@example { "source": "https://allas.se" }']
      );
    });

    Then('the request body example is the route-level example, untouched by property examples', () => {
      const content = doc.paths['/subject'].post.requestBody.content['application/json'];
      expect(content.example).to.deep.equal({ source: 'https://allas.se' });
    });

    And('the shared schema still carries the property example for other operations', () => {
      expect(doc.components.schemas.Signup.properties.source.example).to.equal('https://elle.se');
    });
  });
});
