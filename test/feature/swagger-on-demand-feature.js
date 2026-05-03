import openapiSchemaValidator from 'openapi-schema-validator';
import request from 'supertest';

import { setupApp } from '../../example/index.js';
import { follow } from '../helpers/schema.js';

const OpenAPISchemaValidator = openapiSchemaValidator.default ?? openapiSchemaValidator;

Feature('Swagger on-demand route', () => {
  Scenario('/swagger/live returns a freshly built OpenAPI v3 document', () => {
    /** @type {import('express').Express} */
    let app;
    /** @type {import('supertest').Response} */
    let response;
    /** @type {Record<string, any>} */
    let doc;

    Given('the fixture app is set up', () => {
      app = setupApp();
    });

    When('a client GETs /swagger/live', async () => {
      response = await request(app).get('/swagger/live');
      doc = response.body;
    });

    Then('the response is served with a 200 status', () => {
      expect(response.status).to.equal(200);
    });

    And('the body is a valid OpenAPI 3 document', () => {
      const validator = new OpenAPISchemaValidator({ version: 3 });
      const { errors } = validator.validate(doc);
      expect(errors, `OpenAPI validation errors: ${JSON.stringify(errors, null, 2)}`).to.deep.equal([]);
    });

    And('info.title is taken from the nearest package.json description', () => {
      expect(doc.info.title).to.equal('Express Swagger example fixture');
    });

    And('the components.schemas section exposes each interface as a named schema', () => {
      expect(doc.components, 'components').to.be.an('object');
      expect(doc.components.schemas, 'components.schemas').to.be.an('object');
      expect(doc.components.schemas).to.include.all.keys(
        'CreateUserRequest',
        'CreateUserResponse',
        'GetUserResponse',
        'ListUsersResponse',
        'User'
      );
    });

    And('property-level JSDoc on a body type surfaces as schema property descriptions', () => {
      const user = doc.components.schemas.User;
      expect(user.properties.id.description).to.equal('Stable opaque identifier');
      expect(user.properties.name.description).to.equal('Full display name');
      expect(user.properties.email.description).to.equal('Email address — uniqueness not enforced here');
      expect(user.properties.age.description).to.equal('Optional age in years');

      const record = doc.components.schemas.UserRecord;
      expect(record.properties.createdAt.description).to.equal('When the record was first persisted');
      expect(record.properties.meta.description).to.equal('Free-form metadata bag');
    });

    And('the base User schema contains only the shared properties (no createdAt, no meta)', () => {
      const user = doc.components.schemas.User;
      expect(user, 'User schema').to.be.an('object');
      expect(user.type).to.equal('object');
      expect(user.properties).to.have.all.keys('id', 'name', 'email', 'age');
      expect(user.properties).to.not.have.property('createdAt');
      expect(user.properties).to.not.have.property('meta');
    });

    And('operations reference schemas via $ref to #/components/schemas/...', () => {
      expect(doc.paths['/users'].post.requestBody.content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/CreateUserRequest',
      });
      expect(doc.paths['/users'].post.responses['201'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/CreateUserResponse',
      });
      expect(doc.paths['/users/{id}'].get.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/GetUserResponse',
      });
      expect(doc.paths['/users'].get.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ListUsersResponse',
      });
    });

    And('the POST /users request body matches the CreateUserRequest interface including boolean and bigint', () => {
      const schema = follow(doc, doc.paths?.['/users']?.post?.requestBody?.content?.['application/json']?.schema);
      expect(schema, 'request body schema').to.be.an('object');
      expect(schema.type).to.equal('object');
      expect(schema.properties).to.have.all.keys('name', 'email', 'age', 'verified', 'referralCode');
      expect(schema.properties.name).to.include({ type: 'string' });
      expect(schema.properties.email).to.include({ type: 'string' });
      expect(schema.properties.age).to.include({ type: 'number' });
      expect(schema.properties.verified).to.include({ type: 'boolean' });
      // bigint has no OpenAPI 3 equivalent — the library maps it to `number`.
      expect(schema.properties.referralCode).to.include({ type: 'number' });
      expect(schema.required).to.have.members(['name', 'email', 'verified']);
      expect(schema.required).to.not.include('age');
      expect(schema.required).to.not.include('referralCode');
    });

    And('the POST /users 201 response body matches the CreateUserResponse interface', () => {
      const schema = follow(doc, doc.paths?.['/users']?.post?.responses?.['201']?.content?.['application/json']?.schema);
      expect(schema, 'response schema').to.be.an('object');
      expect(schema.type).to.equal('object');
      expect(schema.properties).to.have.all.keys('id', 'name', 'email', 'age', 'createdAt', 'meta');
      expect(schema.required).to.have.members(['id', 'name', 'email', 'createdAt', 'meta']);
      expect(schema.required).to.not.include('age');
      // `meta: any` maps to an empty schema (matches anything); description is
      // pulled from the property's JSDoc.
      expect(schema.properties.meta).to.deep.equal({ description: 'Free-form metadata bag' });
      // `createdAt: Date` maps to OpenAPI's string + date-time format; description comes from the property's JSDoc.
      expect(schema.properties.createdAt).to.deep.equal({
        type: 'string',
        format: 'date-time',
        description: 'When the record was first persisted',
      });
    });

    And('the GET /users/:id route is keyed by the OpenAPI-style path /users/{id}', () => {
      expect(doc.paths, 'paths').to.have.property('/users/{id}');
      expect(doc.paths['/users/{id}']).to.have.property('get');
      expect(doc.paths, 'express-style key should not leak into the document').to.not.have.property('/users/:id');
    });

    And('the GET /users/{id} id parameter is typed from GetUserPathParams.id', () => {
      const parameters = doc.paths['/users/{id}'].get.parameters;
      expect(parameters, 'parameters').to.be.an('array');
      const idParam = parameters.find((/** @type {any} */ p) => p.name === 'id');
      expect(idParam, 'id parameter').to.exist;
      expect(idParam).to.include({ in: 'path', name: 'id', required: true });
      expect(idParam.schema).to.include({ type: 'number' });
    });

    And('GET /users/{id} 404 response unwraps the error body so the schema is the body type itself', () => {
      const responses = doc.paths['/users/{id}'].get.responses;
      expect(responses, 'responses').to.have.property('404');
      const schema = responses['404'].content['application/json'].schema;
      expect(schema).to.deep.equal({ $ref: '#/components/schemas/ErrorResponseBody' });
    });

    And('the GET /users/{id} 200 response body matches the GetUserResponse interface', () => {
      const schema = follow(doc, doc.paths['/users/{id}'].get.responses?.['200']?.content?.['application/json']?.schema);
      expect(schema, 'response schema').to.be.an('object');
      expect(schema.type).to.equal('object');
      expect(schema.properties).to.have.all.keys('id', 'name', 'email', 'age', 'createdAt', 'meta');
      expect(schema.required).to.have.members(['id', 'name', 'email', 'createdAt', 'meta']);
      expect(schema.properties.meta).to.deep.equal({ description: 'Free-form metadata bag' });
    });

    And('POST /login resolves its types from handler metadata, not the naming convention', () => {
      expect(doc.components.schemas).to.include.all.keys('LoginRequest', 'LoginResponse');
      expect(doc.paths['/login'].post.requestBody.content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/LoginRequest',
      });
    });

    And('POST /login 400 response unwraps to ErrorResponseBody (resolved through a two-hop type alias chain)', () => {
      const op = doc.paths['/login'].post;
      expect(op.responses).to.have.property('400');
      expect(op.responses['400'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('POST /login 401 response unwraps to ErrorResponseBody (resolved through UnauthorizedResponse)', () => {
      const op = doc.paths['/login'].post;
      expect(op.responses).to.have.property('401');
      expect(op.responses['401'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('GET /users/{id} 403 response unwraps to ErrorResponseBody (resolved through ForbiddenResponse)', () => {
      const op = doc.paths['/users/{id}'].get;
      expect(op.responses).to.have.property('403');
      expect(op.responses['403'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('POST /users 404 response unwraps to ErrorResponseBody (resolved through a two-hop interface extends chain)', () => {
      const op = doc.paths['/users'].post;
      expect(op.responses).to.have.property('404');
      expect(op.responses['404'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('POST /users 409 response unwraps to ErrorResponseBody (resolved through ConflictResponse)', () => {
      const op = doc.paths['/users'].post;
      expect(op.responses).to.have.property('409');
      expect(op.responses['409'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('a free-text comment after `@throws {…}` becomes the response description', () => {
      const op = doc.paths['/users'].post;
      expect(op.responses['409'].description).to.equal('user probably already has an account');
      // Other throws responses without a comment retain the empty default.
      expect(op.responses['404'].description).to.equal('');
    });

    And('a free-text comment after `@param {Request<…>} req` becomes the requestBody description', () => {
      const op = doc.paths['/users'].post;
      expect(op.requestBody.description).to.equal('payload describing the user to create');
    });

    And('a free-text comment after `@param {Response<…>} res` becomes the success response description', () => {
      const op = doc.paths['/users'].post;
      expect(op.responses['201'].description).to.equal('the resulting user record');
    });

    And('a literal numeric in slot 2 of the library `ApiResponse<Body, StatusCode>` drives the operation success status', () => {
      const op = doc.paths['/users/{id}/avatar'].put;
      expect(op.responses).to.have.property('202');
      expect(op.responses).to.not.have.property('200');
      expect(op.responses['202'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/UserRecord',
      });
    });

    And('@throws {CreatedResponse<T>} on a default-200 POST emits an additional 201 alongside the 200', () => {
      const op = doc.paths['/maybe-created'].post;
      expect(op.responses).to.have.all.keys('200', '201');
      expect(op.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/NoteRecord',
      });
      expect(op.responses['201'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/NoteRecord',
      });
    });

    And('a user-defined `extends ErrorResponse<T, 418>` chain emits 418 — status read from the type literal, not the registry', () => {
      const op = doc.paths['/users'].post;
      expect(op.responses).to.have.property('418');
      expect(op.responses['418'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
      expect(op.responses['418'].description).to.equal('user is a teapot');
    });

    And('POST /users 500 response unwraps to ErrorResponseBody (resolved through InternalServerErrorResponse)', () => {
      const op = doc.paths['/users'].post;
      expect(op.responses).to.have.property('500');
      expect(op.responses['500'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('POST /login defaults to 200 because its LoginResponse type does not resolve to any status type', () => {
      const responses = doc.paths['/login'].post.responses;
      expect(responses, 'responses').to.have.property('200');
      expect(responses).to.not.have.property('201');
      expect(responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/LoginResponse',
      });
    });

    And('GET /users 400 response unwraps to ErrorResponseBody (resolved through ListUsersBadRequestResponse)', () => {
      const op = doc.paths['/users'].get;
      expect(op.responses, 'responses').to.have.property('400');
      expect(op.responses['400'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('POST /notes returns 201 because CreateNoteResponse aliases CreatedResponse<NoteRecord>', () => {
      const op = doc.paths['/notes'].post;
      expect(op, 'POST /notes operation').to.be.an('object');
      expect(op.responses, 'responses').to.have.property('201');
      expect(op.responses).to.not.have.property('200');
      expect(op.responses['201'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/CreateNoteResponse',
      });
      const resolved = follow(doc, op.responses['201'].content['application/json'].schema);
      expect(resolved.type).to.equal('object');
      expect(resolved.properties).to.have.all.keys('id', 'title', 'body', 'createdAt');
      expect(resolved.properties.createdAt).to.deep.equal({ type: 'string', format: 'date-time' });
      expect(op.requestBody.content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/CreateNoteRequest',
      });
    });

    And('a route whose handler is a named function declaration picks up JSDoc from that declaration', () => {
      const op = doc.paths['/users/alias/{id}']?.get;
      expect(op, 'GET /users/alias/{id}').to.be.an('object');
      expect(op.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/GetUserResponse',
      });
      expect(op.responses).to.have.property('404');
      const idParam = op.parameters?.find((/** @type {any} */ p) => p.name === 'id' && p.in === 'path');
      expect(idParam, 'id parameter').to.exist;
      expect(idParam.schema).to.include({ type: 'number' });
    });

    And('a route whose handler is a const-assigned arrow picks up JSDoc from the enclosing statement', () => {
      const op = doc.paths['/health-arrow']?.get;
      expect(op, 'GET /health-arrow').to.be.an('object');
      expect(op.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/LoginResponse',
      });
    });

    And('GET /recursive builds a schema without recursing forever on a self-referential inner type', () => {
      expect(doc.paths, 'paths').to.have.property('/recursive');
      const op = doc.paths['/recursive'].get;
      expect(op.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/RecursiveResponse',
      });
      const schema = doc.components.schemas.RecursiveResponse;
      expect(schema.type).to.equal('object');
      expect(schema.properties).to.have.all.keys('value', 'node');
      expect(schema.properties.value).to.include({ type: 'string' });
      expect(schema.properties.node.type).to.equal('object');
    });

    And('an endpoint with an unresolved @throws type reference drops the error response silently', () => {
      const op = doc.paths['/notes/{id}']?.get;
      expect(op, 'GET /notes/{id} operation').to.be.an('object');
      expect(op.responses, 'responses').to.not.have.property('404');
    });

    And('GET /users declares query parameters from the ListUsersQuery interface', () => {
      const parameters = doc.paths['/users'].get.parameters;
      expect(parameters, 'parameters').to.be.an('array');

      const search = parameters.find((/** @type {any} */ p) => p.name === 'search' && p.in === 'query');
      expect(search, 'search query parameter').to.exist;
      expect(search.required).to.equal(false);
      expect(search.schema).to.include({ type: 'string' });

      const limit = parameters.find((/** @type {any} */ p) => p.name === 'limit' && p.in === 'query');
      expect(limit, 'limit query parameter').to.exist;
      expect(limit.required).to.equal(true);
      expect(limit.schema).to.include({ type: 'number' });

      const sort = parameters.find((/** @type {any} */ p) => p.name === 'sort' && p.in === 'query');
      expect(sort, 'sort query parameter').to.exist;
      expect(sort.required).to.equal(false);
      // Union of string literals → single string schema with a combined `enum` list.
      expect(sort.schema.type).to.equal('string');
      expect(sort.schema.enum).to.have.members(['asc', 'desc']);
      expect(sort.schema).to.not.have.property('anyOf');

      const roles = parameters.find((/** @type {any} */ p) => p.name === 'roles' && p.in === 'query');
      expect(roles, 'roles query parameter').to.exist;
      expect(roles.schema.type).to.equal('array');
      expect(roles.schema.items.type).to.equal('string');
      expect(roles.schema.items.enum).to.have.members(['admin', 'user', 'guest']);

      const status = parameters.find((/** @type {any} */ p) => p.name === 'status' && p.in === 'query');
      expect(status, 'status query parameter').to.exist;
      expect(status.schema).to.deep.equal({ $ref: '#/components/schemas/UserStatus' });

      const statuses = parameters.find((/** @type {any} */ p) => p.name === 'statuses' && p.in === 'query');
      expect(statuses, 'statuses query parameter').to.exist;
      expect(statuses.schema).to.deep.equal({
        type: 'array',
        items: { $ref: '#/components/schemas/UserStatus' },
      });
    });

    And('an exported enum declaration is registered as a named schema with all its members', () => {
      expect(doc.components.schemas).to.have.property('UserStatus');
      const userStatus = doc.components.schemas.UserStatus;
      expect(userStatus.type).to.equal('string');
      expect(userStatus.enum).to.have.members(['active', 'inactive', 'banned']);
    });

    And('a bare `@deprecated` JSDoc tag flips operation.deprecated to true while keeping any pre-existing description', () => {
      const op = doc.paths['/notes/{id}'].get;
      expect(op.deprecated).to.equal(true);
      expect(op.description, 'description').to.match(/Returns a note by id/);
      expect(op.description).to.not.match(/\*\*Deprecated:\*\*/);
    });

    And('`@deprecated <message>` folds the message into the description', () => {
      const op = doc.paths['/legacy-resource'].get;
      expect(op.deprecated).to.equal(true);
      expect(op.description).to.equal('**Deprecated:** use /v2/resource instead');
    });

    And('an operation without `@deprecated` emits no `deprecated` property', () => {
      const op = doc.paths['/login'].post;
      expect(op).to.not.have.property('deprecated');
    });

    And('the security schemes passed via options.security are exposed under components.securitySchemes', () => {
      expect(doc.components.securitySchemes.bearer).to.deep.equal({ type: 'http', scheme: 'bearer' });
    });

    And('`@security apiKey <header>` auto-emits an apiKey scheme using the JSDoc-supplied header name', () => {
      expect(doc.components.securitySchemes.apiKey).to.deep.equal({
        type: 'apiKey',
        in: 'header',
        name: 'x-my-key-header',
      });
      // Per-op security still references the scheme by name, with no scopes
      // (apiKey schemes don't carry OAuth2-style scopes).
      expect(doc.paths['/users'].get.security).to.deep.equal([{ apiKey: [] }]);
    });

    And('conventional `@security` names auto-emit a default scheme even when not in options.security', () => {
      expect(doc.components.securitySchemes.bearerAuth).to.deep.equal({ type: 'http', scheme: 'bearer' });
      expect(doc.components.securitySchemes.basicAuth).to.deep.equal({ type: 'http', scheme: 'basic' });

      const op = doc.paths['/profile'].get;
      expect(op.security).to.deep.equal([{ bearerAuth: [] }, { basicAuth: [] }]);
    });

    And('`@security openIdConnect <issuer> [scope …]` auto-emits an OIDC scheme and carries the scopes', () => {
      expect(doc.components.securitySchemes.openIdConnect).to.deep.equal({
        type: 'openIdConnect',
        openIdConnectUrl: 'https://issuer.example.com/.well-known/openid-configuration',
      });
      const op = doc.paths['/me-oidc'].get;
      expect(op.security).to.deep.equal([{ openIdConnect: ['openid', 'email'] }]);
    });

    And('a single `@security` JSDoc tag emits the corresponding requirement on the operation', () => {
      const op = doc.paths['/users'].post;
      expect(op.security).to.deep.equal([{ bearer: [] }]);
    });

    And('multiple `@security` lines produce separate alternative requirements with scopes parsed off the first token', () => {
      const op = doc.paths['/users/{id}'].get;
      expect(op.security).to.deep.equal([{ bearer: ['read:users', 'write:users'] }, { apiKey: [] }]);
    });

    And('an operation with no `@security` JSDoc emits no `security` property', () => {
      const op = doc.paths['/login'].post;
      expect(op).to.not.have.property('security');
    });

    And('a route registered with an array of paths gets its JSDoc metadata applied to every path', () => {
      const opA = doc.paths['/array-a']?.get;
      const opB = doc.paths['/array-b']?.get;
      expect(opA, 'GET /array-a').to.be.an('object');
      expect(opB, 'GET /array-b').to.be.an('object');
      expect(opA.tags).to.deep.equal(['arrays']);
      expect(opB.tags).to.deep.equal(['arrays']);
    });

    And('a single `@tag` JSDoc tag emits an OpenAPI tags array on the operation', () => {
      const op = doc.paths['/users'].post;
      expect(op.tags).to.deep.equal(['users']);
    });

    And('multiple `@tag` lines are preserved in declaration order', () => {
      const op = doc.paths['/users/{id}'].get;
      expect(op.tags).to.deep.equal(['users', 'admin']);
    });

    And('operations without any `@tag` JSDoc emit no tags property', () => {
      const op = doc.paths['/login'].post;
      expect(op).to.not.have.property('tags');
    });

    And('an inline `@throws` against a library status type with an indexed-access body emits the resolved body schema directly', () => {
      const op = doc.paths['/inline-error']?.get;
      expect(op, 'GET /inline-error').to.be.an('object');
      expect(op.responses).to.have.property('400');
      const schema = op.responses['400'].content['application/json'].schema;
      expect(schema).to.deep.equal({ $ref: '#/components/schemas/ValidationErrorBody' });
    });

    And('a `BadGatewayResponse` @throws emits a 502 response unwrapped to the body schema', () => {
      const op = doc.paths['/inline-error'].get;
      expect(op.responses).to.have.property('502');
      const schema = op.responses['502'].content['application/json'].schema;
      expect(schema).to.deep.equal({ $ref: '#/components/schemas/ErrorResponseBody' });
    });

    And(
      'inline object literals in `Request<…, ReqBody, Query>` / `Response<Body>` are resolved to schemas with named-type members $ref-d',
      () => {
        const op = doc.paths['/inline-bodies'].post;

        // Request body: { foo: Bar[] } — Bar is a named interface, foo is anonymous.
        const reqSchema = op.requestBody.content['application/json'].schema;
        expect(reqSchema.type).to.equal('object');
        expect(reqSchema.properties.foo).to.deep.equal({
          type: 'array',
          items: { $ref: '#/components/schemas/Bar' },
        });

        // Success response body has the same shape.
        const resSchema = op.responses['200'].content['application/json'].schema;
        expect(resSchema.type).to.equal('object');
        expect(resSchema.properties.foo).to.deep.equal({
          type: 'array',
          items: { $ref: '#/components/schemas/Bar' },
        });

        // Query: { prefix?: string } — single optional string parameter.
        const prefixParam = op.parameters.find((/** @type {any} */ p) => p.name === 'prefix' && p.in === 'query');
        expect(prefixParam, 'prefix query parameter').to.exist;
        expect(prefixParam.required).to.equal(false);
        expect(prefixParam.schema).to.include({ type: 'string' });

        // Bar interface should still be registered as a top-level component.
        expect(doc.components.schemas).to.have.property('Bar');
        // Mixed-primitive non-literal union → `anyOf` of two non-collapsable schemas.
        const extra = doc.components.schemas.Bar.properties.extra;
        expect(extra, 'Bar.extra schema').to.have.property('anyOf');
        expect(extra.anyOf).to.deep.include.members([{ type: 'string' }, { type: 'number' }]);
      }
    );

    And('a response alias built from a JS Error class via indexed-access types resolves to the underlying body', () => {
      expect(doc.components.schemas).to.have.property('ValidationErrorBody');

      const validationBody = doc.components.schemas.ValidationErrorBody;
      expect(validationBody.type).to.equal('object');
      expect(validationBody.properties).to.have.property('errors');
      expect(validationBody.properties.errors.type).to.equal('array');

      // The throws response unwraps to the body type itself, not the
      // CreateNoteBadRequestResponse wrapper alias.
      const op = doc.paths['/notes'].post;
      expect(op.responses).to.have.property('400');
      expect(op.responses['400'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ValidationErrorBody',
      });
    });

    And('an enum whose members carry no initializer uses the member names as values', () => {
      expect(doc.components.schemas).to.have.property('Direction');
      const direction = doc.components.schemas.Direction;
      expect(direction.type).to.equal('string');
      expect(direction.enum).to.have.ordered.members(['Up', 'Down', 'Left', 'Right']);
    });

    And('a route typed with an enum response body $refs the registered enum schema', () => {
      const op = doc.paths['/users/{id}/status']?.get;
      expect(op, 'GET /users/{id}/status').to.be.an('object');
      expect(op.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/UserStatus',
      });
    });

    And('a route with `@contentType text/html` emits the HTML media-type instead of `application/json`', () => {
      const op = doc.paths['/landing-page'].get;
      expect(op.responses['200'].content, '200 content').to.have.property('text/html');
      expect(op.responses['200'].content).to.not.have.property('application/json');
      expect(op.responses['200'].content['text/html'].schema).to.deep.equal({ type: 'string' });
    });

    And(
      'DELETE /cache/{key} typed with `Response<NoContentResponse>` directly emits 204 with no `content` block (status walked off the type chain)',
      () => {
        const op = doc.paths['/cache/{key}'].delete;
        expect(op, 'DELETE /cache/{key} operation').to.be.an('object');
        expect(op.responses, 'responses').to.have.property('204');
        expect(op.responses['204']).to.deep.equal({ description: '' });
        expect(op.responses['204']).to.not.have.property('content');
      }
    );

    And('DELETE /cache/direct/{key} typed with bare `_res: NoContentResponse` (no `Response<…>` wrapper) also emits 204', () => {
      const op = doc.paths['/cache/direct/{key}'].delete;
      expect(op, 'DELETE /cache/direct/{key} operation').to.be.an('object');
      expect(op.responses, 'responses').to.have.property('204');
      expect(op.responses['204']).to.deep.equal({ description: '' });
      expect(op.responses['204']).to.not.have.property('content');
    });

    And('DELETE /users/{id} exposes a 204 No Content success response with no body', () => {
      const op = doc.paths['/users/{id}']?.delete;
      expect(op, 'DELETE operation').to.be.an('object');
      expect(op.responses, 'responses').to.have.property('204');
      expect(op.responses['204']).to.deep.equal({ description: '' });
      expect(op.responses['204']).to.not.have.property('content');
    });

    And('DELETE /users/{id} declares the id path parameter with type number', () => {
      const parameters = doc.paths['/users/{id}'].delete.parameters;
      expect(parameters, 'parameters').to.be.an('array');
      const idParam = parameters.find((/** @type {any} */ p) => p.name === 'id' && p.in === 'path');
      expect(idParam, 'id parameter').to.exist;
      expect(idParam.schema).to.include({ type: 'number' });
    });

    And('DELETE /users/{id} declares a 404 response unwrapped to ErrorResponseBody (from @throws metadata)', () => {
      const op = doc.paths['/users/{id}'].delete;
      expect(op.responses).to.have.property('404');
      expect(op.responses['404'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('DELETE /users/{id} 400 response unwraps to ErrorResponseBody (from interface extending BadRequestResponse)', () => {
      const op = doc.paths['/users/{id}'].delete;
      expect(op.responses).to.have.property('400');
      expect(op.responses['400'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('public router routes appear with the optional {*splat} wildcard stripped', () => {
      expect(doc.paths, 'paths').to.have.property('/multer/version');
      expect(doc.paths['/multer/version']).to.have.property('get');
      expect(doc.paths['/multer/version'].get.parameters ?? []).to.not.deep.include({ name: 'splat' });
    });

    And('routes registered with a template-literal path and a call-wrapped handler still surface', () => {
      expect(doc.paths, 'paths').to.have.property('/multer/status');
      const op = doc.paths['/multer/status'].get;
      expect(op, 'GET /multer/status').to.be.an('object');
      expect(op.description, 'description from JSDoc on the inner arrow fn').to.match(/health status/i);
      expect(op.responses).to.have.property('200');
      expect(op.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/GetStatusResponse',
      });
    });

    And('GET /multer/version description is extracted from the handler JSDoc', () => {
      expect(doc.paths['/multer/version'].get.description).to.match(/package version/i);
    });

    And('GET /multer/version response uses GetVersionResponse from the middleware @typedef', () => {
      const schema = doc.paths['/multer/version'].get.responses['200'].content['application/json'].schema;
      expect(schema).to.deep.equal({ $ref: '#/components/schemas/GetVersionResponse' });
      const followed = follow(doc, schema);
      expect(followed.type).to.equal('object');
      expect(followed.properties).to.have.property('version');
      expect(followed.properties.version).to.include({ type: 'string' });
    });

    And('components.schemas includes GetVersionResponse discovered from the JS middleware', () => {
      expect(doc.components.schemas).to.have.property('GetVersionResponse');
    });

    And('handlers marked with @private JSDoc are omitted', () => {
      expect(doc.paths, 'paths').to.not.have.property('/multer/deployment/create');
    });

    And('handlers marked with @ignore are omitted', () => {
      expect(doc.paths, 'paths').to.not.have.property('/internal-ignored');
    });

    And('a route whose handler is a higher-order call still respects `@ignore` on the route statement', () => {
      expect(doc.paths, 'paths').to.not.have.property('/internal-tool');
    });

    And('handlers marked with @internal are omitted', () => {
      expect(doc.paths, 'paths').to.not.have.property('/internal-marked');
    });

    And('handlers marked with @protected are omitted', () => {
      expect(doc.paths, 'paths').to.not.have.property('/internal-protected');
    });

    And('the GET /users 200 response body is an array matching ListUsersResponse', () => {
      const listSchema = follow(doc, doc.paths?.['/users']?.get?.responses?.['200']?.content?.['application/json']?.schema);
      expect(listSchema, 'list response schema').to.be.an('object');
      expect(listSchema.type).to.equal('array');
      const itemSchema = follow(doc, listSchema.items);
      expect(itemSchema, 'array items schema').to.be.an('object');
      expect(itemSchema.type).to.equal('object');
      expect(itemSchema.properties).to.have.all.keys('id', 'name', 'email', 'age', 'createdAt', 'meta');
      expect(itemSchema.required).to.have.members(['id', 'name', 'email', 'createdAt', 'meta']);
    });

    And('a route registered with a `const`-bound path string surfaces under that path', () => {
      // Exercises the identifier-bound branch of resolveStaticString — the
      // path is referenced via `app.get(TEAPOTS_ROUTE_PATH, …)`, not a literal.
      expect(doc.paths, 'paths').to.have.property('/teapots');
      expect(doc.paths['/teapots']).to.have.property('get');
    });

    And('a `type X = ErrorResponse<Body, NNN>` alias (bare identifier) drives the @throws status & body unwrap', () => {
      // `DirectTeapotResponse = ErrorResponse<ErrorResponseBody, 418>` exercises
      // the bare-identifier `ErrorResponse<…>` branch of inferFromTypeNode.
      // Verify via the operation-level effect: GET /teapot-direct's 418 response
      // unwraps to ErrorResponseBody.
      const op = doc.paths['/teapot-direct'].get;
      expect(op.responses['418'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('a `type X = import(...).ErrorResponse<Body, NNN>` alias drives the same unwrap via the ImportTypeNode branch', () => {
      // `ImportedLegalReasonsResponse = import('@aller/express-swagger').ErrorResponse<ErrorResponseBody, 451>`
      // exercises the ImportTypeNode branch of inferFromTypeNode.
      const op = doc.paths['/teapot-imported'].get;
      expect(op.responses['451'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/ErrorResponseBody',
      });
    });

    And('a `@throws {NoContentResponse}`-derived 204 is emitted as a body-less response with no `content` block', () => {
      // The throws entry resolves to status 204; resolveInlineThrows skips
      // setting an inlineSchema, so buildOperation lands in the body-less
      // branch.
      const op = doc.paths['/teapots'].get;
      expect(op.responses, '204 throws response').to.have.property('204');
      expect(op.responses['204']).to.deep.equal({ description: 'nothing to brew' });
      expect(op.responses['204']).to.not.have.property('content');
    });

    And(
      'an inline JSDoc `@typedef {ApiResponse<X, NNN>} Y` propagates NNN into the statusByType registry — `Response<Y>` pins the success status',
      () => {
        const op = doc.paths['/users/{id}/inline-accepted'].post;
        expect(op.responses, 'responses').to.have.property('202');
        expect(op.responses).to.not.have.property('200');
        expect(op.responses['202'].content['application/json'].schema).to.deep.equal({
          $ref: '#/components/schemas/InlineAcceptedResponse',
        });
        expect(doc.components.schemas.InlineAcceptedResponse).to.deep.equal({
          $ref: '#/components/schemas/UserRecord',
        });
      }
    );

    And(
      'an inline JSDoc `@typedef {CreatedResponse<X>} Y` follows the import-type qualifier through CreatedResponse → ApiResponse<T, 201>',
      () => {
        const op = doc.paths['/users/{id}/inline-created'].post;
        expect(op.responses, 'responses').to.have.property('201');
        expect(op.responses).to.not.have.property('200');
      }
    );

    And("a bare `@param {Response} res` (no generic) falls back to Request<P, ResBody, …>'s ResBody slot", () => {
      const op = doc.paths['/users/{id}/short'].get;
      expect(op.responses['200'].content['application/json'].schema).to.deep.equal({
        $ref: '#/components/schemas/GetUserResponse',
      });
    });

    And('deprecated wrapper-object types (`Number`/`String`/`Boolean`) are coerced to their primitive schemas', () => {
      const schema = doc.components.schemas.DeprecatedWrappers;
      expect(schema, 'DeprecatedWrappers schema').to.be.an('object');
      expect(schema.properties.num).to.deep.equal({ type: 'number' });
      expect(schema.properties.str).to.deep.equal({ type: 'string' });
      expect(schema.properties.bool).to.deep.equal({ type: 'boolean' });
    });

    And(
      '`Symbol` / `Object` / lowercase `symbol` properties are dropped from the schema (none of them serialize to JSON meaningfully)',
      () => {
        const schema = doc.components.schemas.DeprecatedWrappers;
        expect(schema.properties).to.not.have.property('sym');
        expect(schema.properties).to.not.have.property('obj');
        expect(schema.properties).to.not.have.property('symPrim');
        expect(schema.required ?? []).to.have.members(['num', 'str', 'bool']);
        expect(schema.required ?? []).to.not.include('sym');
        expect(schema.required ?? []).to.not.include('obj');
        expect(schema.required ?? []).to.not.include('symPrim');
      }
    );
  });
});
