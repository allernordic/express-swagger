import openapiSchemaValidator from 'openapi-schema-validator';

import { setupApp } from '../../example/index.js';
import { buildSwaggerDocument } from '@aller/express-swagger';

const OpenAPISchemaValidator = openapiSchemaValidator.default ?? openapiSchemaValidator;

Feature('Building swagger without a tsconfig', () => {
  Scenario('buildSwaggerDocument works without a tsconfig option and produces a schema-less doc', () => {
    /** @type {Record<string, any>} */
    let doc;

    Given('the fixture app is set up and buildSwaggerDocument is called with no options', async () => {
      const app = setupApp();
      doc = await buildSwaggerDocument(app);
    });

    Then('the document is still a valid OpenAPI 3 document', () => {
      const validator = new OpenAPISchemaValidator({ version: 3 });
      const { errors } = validator.validate(doc);
      expect(errors, `OpenAPI validation errors: ${JSON.stringify(errors, null, 2)}`).to.deep.equal([]);
    });

    And('it contains paths walked from the Express router', () => {
      expect(doc.paths).to.include.all.keys('/users', '/users/{id}', '/login');
    });

    And('the document has no components.schemas section because no types were loaded', () => {
      expect(doc).to.not.have.property('components');
    });

    And('request/response bodies fall back to the generic object stub and every route defaults to 200', () => {
      expect(doc.paths['/users'].post.requestBody.content['application/json'].schema).to.deep.equal({ type: 'object' });
      expect(doc.paths['/users'].post.responses).to.have.property('200');
      expect(doc.paths['/users'].post.responses).to.not.have.property('201');
      expect(doc.paths['/users'].post.responses['200'].content['application/json'].schema).to.deep.equal({ type: 'object' });
    });

    And('@private filtering and mount-prefix recovery are no-ops without a tsconfig', () => {
      // Both features rely on AST analysis of the source; without a tsconfig the
      // library skips that pass entirely. Multer's routes therefore appear, and
      // without their `/multer` mount prefix.
      expect(doc.paths).to.have.property('/deployment/create');
      expect(doc.paths).to.have.property('/version');
    });
  });
});
