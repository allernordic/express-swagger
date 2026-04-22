import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import openapiSchemaValidator from 'openapi-schema-validator';
import request from 'supertest';

import { setupApp } from '../../example/index.js';
import { buildSwaggerDocument } from '@aller/express-swagger';

const OpenAPISchemaValidator = openapiSchemaValidator.default ?? openapiSchemaValidator;

const TSCONFIG_PATH = new URL('../../example/tsconfig.json', import.meta.url);
const PUBLIC_DIR = fileURLToPath(new URL('../../example/public/', import.meta.url));
const SWAGGER_FILE = path.join(PUBLIC_DIR, 'swagger.json');

Feature('Pre-built swagger served as a static file', () => {
  Scenario('public/swagger.json is served by express.static at /swagger.json', () => {
    /** @type {import('express').Express} */
    let app;
    /** @type {Record<string, any>} */
    let builtDoc;
    /** @type {import('supertest').Response} */
    let response;
    /** @type {Record<string, any>} */
    let servedDoc;

    Given('swagger is pre-built and written to example/public/swagger.json', async () => {
      const sourceApp = setupApp();
      builtDoc = await buildSwaggerDocument(sourceApp, { tsconfig: TSCONFIG_PATH });
      await mkdir(PUBLIC_DIR, { recursive: true });
      await writeFile(SWAGGER_FILE, JSON.stringify(builtDoc, null, 2));
    });

    And('the fixture app is set up (which mounts express.static on the public dir)', () => {
      app = setupApp();
    });

    When('a client GETs /swagger.json', async () => {
      response = await request(app).get('/swagger.json');
      servedDoc = response.body;
    });

    Then('the response is served with a 200 status', () => {
      expect(response.status).to.equal(200);
    });

    And('the body is a valid OpenAPI 3 document', () => {
      const validator = new OpenAPISchemaValidator({ version: 3 });
      const { errors } = validator.validate(servedDoc);
      expect(errors, `OpenAPI validation errors: ${JSON.stringify(errors, null, 2)}`).to.deep.equal([]);
    });

    And('the served document equals the pre-built document', () => {
      expect(servedDoc).to.deep.equal(builtDoc);
    });

    And('the served document describes the fixture routes and schemas', () => {
      expect(servedDoc.paths).to.include.all.keys('/users', '/users/{id}', '/login');
      expect(servedDoc.components.schemas).to.include.all.keys('CreateUserRequest', 'LoginResponse', 'ErrorResponseBody');
    });

    And('the served document exposes DELETE /users/{id} with a 204 response', () => {
      expect(servedDoc.paths['/users/{id}']).to.have.property('delete');
      expect(servedDoc.paths['/users/{id}'].delete.responses).to.have.property('204');
    });
  });
});
