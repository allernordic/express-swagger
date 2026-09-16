import openapiSchemaValidator from 'openapi-schema-validator';

const OpenAPISchemaValidator = 'default' in openapiSchemaValidator ? openapiSchemaValidator.default : openapiSchemaValidator;

/**
 * @param {Record<string, any>} doc
 * @returns {import('openapi-schema-validator').OpenAPISchemaValidatorResult}
 */
export function validateOpenApi(doc) {
  return new OpenAPISchemaValidator({ version: 3 }).validate(/** @type {any} */ (doc));
}
