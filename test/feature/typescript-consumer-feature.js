import openapiSchemaValidator from 'openapi-schema-validator';

import { buildSwaggerDocument } from '@aller/express-swagger';
import { setupApp } from '../../example-ts/index.ts';
import { follow } from '../helpers/schema.js';

const OpenAPISchemaValidator = openapiSchemaValidator.default ?? openapiSchemaValidator;
const TSCONFIG_PATH = new URL('../../example-ts/tsconfig.json', import.meta.url);

Feature('TypeScript-source consumer', () => {
  Scenario('buildSwaggerDocument produces a valid OpenAPI 3 spec from a .ts Express app', () => {
    /** @type {import('express').Express} */
    let app;
    /** @type {Record<string, any>} */
    let doc;

    Given('a fixture Express app whose routes and types live in .ts source', () => {
      app = setupApp();
    });

    When('buildSwaggerDocument is called against the TS fixture tsconfig', async () => {
      doc = await buildSwaggerDocument(app, { tsconfig: TSCONFIG_PATH });
    });

    Then('the resulting document validates as OpenAPI 3', () => {
      const validator = new OpenAPISchemaValidator({ version: 3 });
      const { errors } = validator.validate(doc);
      expect(errors, `OpenAPI validation errors: ${JSON.stringify(errors, null, 2)}`).to.deep.equal([]);
    });

    And('every route registered in the .ts source is present in paths', () => {
      expect(doc.paths, 'paths').to.be.an('object');
      expect(doc.paths['/widgets'], 'GET /widgets path entry').to.have.property('get');
      expect(doc.paths['/widgets'], 'POST /widgets path entry').to.have.property('post');
      expect(doc.paths['/widgets/{id}'], 'GET /widgets/{id} path entry').to.have.property('get');
      expect(doc.paths['/widgets/{id}'], 'DELETE /widgets/{id} path entry').to.have.property('delete');
    });

    And('a TypeScript interface is exposed as a named schema in components.schemas', () => {
      expect(doc.components, 'components').to.be.an('object');
      expect(doc.components.schemas, 'components.schemas').to.be.an('object');
      expect(doc.components.schemas).to.include.keys('Widget', 'CreateWidget', 'WidgetError');

      const widget = doc.components.schemas.Widget;
      expect(widget.type).to.equal('object');
      expect(widget.properties).to.include.all.keys('id', 'name');
      expect(widget.properties.id.type).to.equal('string');
      expect(widget.properties.name.type).to.equal('string');
    });

    And('a JSDoc-tagged TS handler resolves its response body to a $ref of the interface schema', () => {
      const responseSchema = doc.paths['/widgets/{id}'].get.responses['200'].content['application/json'].schema;
      expect(follow(doc, responseSchema)).to.equal(doc.components.schemas.Widget);
    });

    And('JSDoc @throws on a .ts handler produces an error response entry', () => {
      const getResponses = doc.paths['/widgets/{id}'].get.responses;
      expect(getResponses).to.have.property('404');
      const errorSchema = getResponses['404'].content['application/json'].schema;
      expect(follow(doc, errorSchema)).to.equal(doc.components.schemas.WidgetError);
    });

    And('a TS-annotated handler reads Request<P, ResBody, ReqBody> from the parameter type', () => {
      const post = doc.paths['/widgets'].post;
      expect(post.requestBody, 'requestBody').to.be.an('object');
      const requestSchema = post.requestBody.content['application/json'].schema;
      expect(follow(doc, requestSchema)).to.equal(doc.components.schemas.CreateWidget);
    });

    And('ApiResponse<Widget, 201> on a TS-annotated res parameter pins the success status to 201', () => {
      const postResponses = doc.paths['/widgets'].post.responses;
      expect(postResponses).to.have.property('201');
      expect(postResponses).to.not.have.property('200');
      const created = postResponses['201'].content['application/json'].schema;
      expect(follow(doc, created)).to.equal(doc.components.schemas.Widget);
    });

    And('a bare TS-annotated NoContentResponse chain-walks to a 204 (body-less) response', () => {
      const del = doc.paths['/widgets/{id}'].delete;
      expect(del.responses).to.have.property('204');
      expect(del.responses['204']).to.not.have.property('content');
    });

    And('TS-annotated path params surface as path parameters in the operation', () => {
      const del = doc.paths['/widgets/{id}'].delete;
      expect(del.parameters, 'DELETE /widgets/{id} parameters').to.be.an('array').with.lengthOf(1);
      expect(del.parameters[0]).to.deep.include({ name: 'id', in: 'path', required: true });
      expect(del.parameters[0].schema.type).to.equal('string');
    });

    And('Response<Widget> on res alone fills the response slot when Request<P> carries no ResBody', () => {
      const responses = doc.paths['/widgets/{id}/summary'].get.responses;
      expect(responses).to.have.property('200');
      const schema = responses['200'].content['application/json'].schema;
      expect(follow(doc, schema)).to.equal(doc.components.schemas.Widget);
    });

    And("ApiResponse<string, 200, 'text/html'> pins the response media type to text/html", () => {
      const responses = doc.paths['/widgets/landing'].get.responses;
      expect(responses).to.have.property('200');
      expect(responses['200'].content).to.have.property('text/html');
      expect(responses['200'].content).to.not.have.property('application/json');
      expect(responses['200'].content['text/html'].schema).to.deep.equal({ type: 'string' });
    });
  });
});
