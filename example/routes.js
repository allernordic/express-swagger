/** @typedef {import('types').CreateUserRequest} CreateUserRequest */
/** @typedef {import('types').CreateUserResponse} CreateUserResponse */
/** @typedef {import('types').GetUserResponse} GetUserResponse */
/** @typedef {import('types').GetUserPathParams} GetUserPathParams */
/** @typedef {import('types').ListUsersResponse} ListUsersResponse */
/** @typedef {import('types').ListUsersQuery} ListUsersQuery */
/** @typedef {import('types').LoginResponse} LoginResponse */
/** @typedef {import('types').GetUserNotFoundResponse} GetUserNotFoundResponse */
/** @typedef {import('types').DeleteUserResponse} DeleteUserResponse */
/** @typedef {import('types').CreateNoteResponse} CreateNoteResponse */
/** @typedef {import('types').NoteRecord} NoteRecord */
/** @typedef {import('types').UserRecord} UserRecord */

import multer from 'multer';

/**
 * Fetch a user by alias — exercises swagger generation when the handler is a
 * separately-declared named function passed by reference to `app.get(...)`.
 *
 * @param {import('express').Request<GetUserPathParams, GetUserResponse>} _req
 * @param {import('express').Response<GetUserResponse>} res
 * @throws {GetUserNotFoundResponse}
 */
function getUserByAlias(_req, res) {
  res.status(200).json({
    id: 'alias',
    name: 'Ada',
    email: 'ada@example.com',
    createdAt: new Date(),
    meta: {},
  });
}

/**
 * Health check — exercises swagger generation when the handler is a const
 * assigned to an arrow function (jsDoc lives on the VariableStatement).
 *
 * @param {import('express').Request} _req
 * @param {import('express').Response<LoginResponse>} res
 */
const healthArrowHandler = (_req, res) => res.status(200).json({ token: '', expiresAt: '' });

/**
 * Higher-order factory that returns a request handler. Used to demonstrate
 * routes whose handler argument is a `factory(...)` call expression — the
 * pattern `app.get('/x', apiReference(...))` and friends.
 *
 * @returns {import('express').RequestHandler}
 */
function makeNoOpHandler() {
  return (_req, res) => res.status(200).json({});
}

/** @param {import('express').Express} app */
export function applyRoutes(app) {
  app.post(
    '/users',
    /**
     * @param {import('express').Request<{}, CreateUserResponse, CreateUserRequest>} req payload describing the user to create
     * @param {import('express').Response<CreateUserResponse>} res the resulting user record
     * @throws {import('types').CreateUserNotFoundResponse}
     * @throws {import('types').CreateUserConflictResponse} user probably already has an account
     * @throws {import('types').CreateUserTeapotResponse} user is a teapot
     * @throws {import('types').CreateUserInternalServerErrorResponse}
     * @tag users
     * @security bearer
     */
    (req, res) => {
      const { name, email, age } = req.body;
      res.status(201).json(
        /** @type {any} */ ({
          id: 'u_1',
          name,
          email,
          age,
          createdAt: new Date(),
          meta: {},
        })
      );
    }
  );

  app.get(
    '/users',
    /**
     * @param {import('express').Request<{}, ListUsersResponse, unknown, ListUsersQuery>} _req
     * @param {import('express').Response<ListUsersResponse>} res
     * @throws {import('types').ListUsersBadRequestResponse}
     * @security apiKey x-my-key-header
     */
    (_req, res) => {
      res.status(200).json([
        {
          id: 'u_1',
          name: 'Ada',
          email: 'ada@example.com',
          createdAt: new Date(),
          meta: {},
        },
      ]);
    }
  );

  app.post(
    '/login',
    /**
     * @param {import('express').Request<{}, LoginResponse, import('types').LoginRequest>} req
     * @param {import('express').Response<LoginResponse>} res
     * @throws {import('types').LoginBadRequestResponse}
     * @throws {import('types').LoginUnauthorizedResponse}
     */
    (req, res) => {
      const { username } = req.body;
      res.status(200).json({
        token: `token-for-${username}`,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
  );

  app.get(
    '/users/:id',
    /**
     * @param {import('express').Request<GetUserPathParams, GetUserResponse>} req
     * @param {import('express').Response<GetUserResponse>} res
     * @throws {GetUserNotFoundResponse}
     * @throws {import('types').GetUserForbiddenResponse}
     * @tag users
     * @tag admin
     * @security bearer read:users write:users
     * @security apiKey
     */
    (req, res) => {
      res.status(200).json({
        id: String(req.params.id),
        name: 'Ada',
        email: 'ada@example.com',
        createdAt: new Date(),
        meta: {},
      });
    }
  );

  app.post(
    '/notes',
    /**
     * Create a new note. The `CreateNoteResponse` type aliases
     * `CreatedResponse<NoteRecord>`, so the library emits a 201 with the
     * note record as the response body.
     * @param {import('express').Request<{}, CreateNoteResponse, import('types').CreateNoteRequest>} req
     * @param {import('express').Response<CreateNoteResponse>} res
     * @throws {import('types').CreateNoteBadRequestResponse}
     */
    (req, res) => {
      const { title, body } = req.body;
      res.status(201).json(
        /** @type {any} */ ({
          id: 'n_1',
          title,
          body,
          createdAt: new Date(),
        })
      );
    }
  );

  app.get(
    '/notes/:id',
    /**
     * Returns a note by id. The @throws references a type that isn't defined
     * anywhere, so the library should silently drop the error response.
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @throws {GetNoteNotFoundResponse}
     * @deprecated
     */
    (_req, res) => res.status(200).json({})
  );

  app.get(
    '/legacy-resource',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @deprecated use /v2/resource instead
     */
    (_req, res) => res.status(200).json({})
  );

  app.get(
    ['/array-a', '/array-b'],
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @tag arrays
     */
    (_req, res) => res.status(200).json({})
  );

  app.get(
    '/profile',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @security bearerAuth
     * @security basicAuth
     */
    (_req, res) => res.status(200).json({})
  );

  app.post(
    '/maybe-created',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response<NoteRecord>} res
     * @throws {import('@aller/express-swagger').CreatedResponse<NoteRecord>}
     */
    (_req, res) => res.status(200).json(/** @type {any} */ ({}))
  );

  /**
   * @param {import('express').Request<GetUserPathParams, UserRecord>} _req
   * @param {import('@aller/express-swagger').ApiResponse<UserRecord, 202>} _res
   */
  // eslint-disable-next-line no-unused-vars
  function putAvatar(_req, _res) {
    /* fixture-only — the body matches because Express's RequestHandler links
       Request slot 2 with Response's body type. */
  }
  app.put('/users/:id/avatar', putAvatar);

  app.get(
    '/me-oidc',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @security openIdConnect https://issuer.example.com/.well-known/openid-configuration openid email
     */
    (_req, res) => res.status(200).json({})
  );

  app.get(
    '/inline-error',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @throws {import('@aller/express-swagger').BadRequestResponse<import('./errors.js').BadRequestError['body']>}
     * @throws {import('@aller/express-swagger').BadGatewayResponse<import('types').ErrorResponseBody>}
     */
    (_req, res) => res.status(200).json({})
  );

  /** @ignore */
  app.get('/internal-tool', makeNoOpHandler());

  app.get(
    '/internal-ignored',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @ignore
     */
    (_req, res) => res.status(200).json({})
  );

  app.get(
    '/internal-protected',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @protected
     */
    (_req, res) => res.status(200).json({})
  );

  app.get(
    '/internal-marked',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @internal
     */
    (_req, res) => res.status(200).json({})
  );

  app.get('/users/alias/:id', getUserByAlias);

  app.post(
    '/inline-bodies',
    /**
     * @param {import('express').Request<unknown, any, { foo: import('types').Bar[] }, { prefix?: string }>} req
     * @param {import('express').Response<{ foo: import('types').Bar[] }>} res
     */
    (req, res) => res.status(200).json({ foo: req.body.foo })
  );

  app.get(
    '/users/:id/status',
    /**
     * @param {import('express').Request<GetUserPathParams>} _req
     * @param {import('express').Response<import('types').UserStatus>} res
     */
    (_req, res) => res.status(200).json(/** @type {any} */ ('active'))
  );

  app.get('/health-arrow', healthArrowHandler);

  app.get(
    '/users/:id/short',
    /**
     * Bare `@param {Response} res` with no generic — the response schema
     * should fall back to the `ResBody` slot of `Request<P, ResBody, …>`.
     * @param {import('express').Request<GetUserPathParams, GetUserResponse>} _req
     * @param {import('express').Response} res
     */
    (_req, res) => res.status(200).json(/** @type {any} */ ({}))
  );

  app.get(
    '/recursive',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response<import('types').RecursiveResponse>} res
     */
    (_req, res) => res.status(200).json(/** @type {any} */ ({}))
  );

  app.get(
    '/landing-page',
    /**
     * The wire media type is carried on the response type. Walks the chain
     * through `HtmlResponse<string>` → `ApiResponse<string, 200, 'text/html'>`
     * and picks `text/html` off the third type-arg.
     * @param {import('express').Request} _req
     * @param {import('@aller/express-swagger').HtmlResponse<string>} res
     */
    (_req, res) => res.status(200).type('html').send('<h1>hi</h1>')
  );

  app.get(
    '/avatar.png',
    /**
     * Direct `ApiResponse<T, N, M>` use — the third generic pins the media
     * type without needing a wrapper alias.
     * @param {import('express').Request} _req
     * @param {import('@aller/express-swagger').ApiResponse<import('@aller/express-swagger').Binary, 200, 'image/png'>} res
     */
    (_req, res) => res.status(200).type('png').end()
  );

  // Routes that reference otherwise-orphan example types so the prune walk
  // keeps them in components.schemas (the @throws / @param references make
  // each type transitively reachable from at least one operation).
  app.get(
    '/teapot-direct',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @throws {import('types').DirectTeapotResponse}
     */
    (_req, res) => res.status(200).json({})
  );

  app.get(
    '/teapot-imported',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @throws {import('types').ImportedLegalReasonsResponse}
     */
    (_req, res) => res.status(200).json({})
  );

  app.get(
    '/wrappers-demo',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response<import('types').DeprecatedWrappers>} res
     */
    (_req, res) => res.status(200).json(/** @type {any} */ ({}))
  );

  app.get(
    '/users/base',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response<import('types').User>} res
     */
    (_req, res) => res.status(200).json(/** @type {any} */ ({}))
  );

  /**
   * `RequestHandler<P, ResBody, ReqBody, Query>` carries all four slot types
   * on the handler itself — the library reads them as if the function had a
   * `@param {Request<P, ResBody, ReqBody, Query>} req` tag.
   *
   * @type {import('express').RequestHandler<GetUserPathParams, GetUserResponse, CreateUserRequest, ListUsersQuery>}
   */
  const patchUser = (_req, res) => res.status(200).json(/** @type {any} */ ({}));
  app.patch('/users/:id/typed', patchUser);

  /**
   * Higher-order factory whose `@returns` is a fully-typed `RequestHandler`.
   * The library treats `@returns RequestHandler<…>` like `@type RequestHandler<…>`
   * on the handler itself — covers the very common Express pattern of writing
   * `app.METHOD(path, makeHandler(deps))` to inject dependencies.
   *
   * @returns {import('express').RequestHandler<GetUserPathParams, GetUserResponse, CreateUserRequest, ListUsersQuery>}
   */
  function makeTypedUserHandler() {
    return (_req, res) => res.status(200).json(/** @type {any} */ ({}));
  }
  app.put('/users/:id/factory-typed', makeTypedUserHandler());

  /**
   * Express also accepts an array of middleware. A factory typed as
   * `RequestHandler<…>[]` should still surface the slot types — the library
   * peels the array wrapper off the `@returns` typeNode.
   *
   * @returns {import('express').RequestHandler<GetUserPathParams, GetUserResponse, CreateUserRequest, ListUsersQuery>[]}
   */
  function makeTypedUserHandlerArray() {
    return [(_req, res) => res.status(200).json(/** @type {any} */ ({}))];
  }
  app.patch('/users/:id/factory-array', ...makeTypedUserHandlerArray());

  /**
   * Long-form `Array<RequestHandler<…>>`. Behaves identically to the shorthand
   * `RequestHandler<…>[]` — the library peels both forms.
   *
   * @returns {Array<import('express').RequestHandler<GetUserPathParams, GetUserResponse, CreateUserRequest, ListUsersQuery>>}
   */
  function makeTypedUserHandlerArrayLong() {
    return [(_req, res) => res.status(200).json(/** @type {any} */ ({}))];
  }
  app.patch('/users/:id/factory-array-long', ...makeTypedUserHandlerArrayLong());

  /**
   * Async factory — `@returns Promise<RequestHandler<…>>`. The library peels
   * the `Promise` wrapper (already used for response-body unwrapping) and
   * reads the slot types off the inner `RequestHandler`. The fixture cheats
   * the runtime side with an `any` cast so we don't have to make
   * `applyRoutes` async — the library only reads the JSDoc statically.
   *
   * @returns {Promise<import('express').RequestHandler<GetUserPathParams, GetUserResponse, CreateUserRequest, ListUsersQuery>>}
   */
  function makeAsyncTypedUserHandler() {
    return /** @type {any} */ ((/** @type {any} */ _req, /** @type {import('express').Response} */ res) => res.status(200).json({}));
  }
  app.post('/users/:id/factory-async', /** @type {any} */ (makeAsyncTypedUserHandler()));

  /**
   * `@type` carrying a middleware array — `RequestHandler<…>[]`. Same peel
   * behaviour as the factory case but on the handler annotation itself.
   *
   * @type {import('express').RequestHandler<GetUserPathParams, GetUserResponse, CreateUserRequest, ListUsersQuery>[]}
   */
  const deleteUserMiddleware = [(_req, res) => res.status(200).json(/** @type {any} */ ({}))];
  app.delete('/users/:id/typed-array', ...deleteUserMiddleware);

  app.post(
    '/deployments',
    multer().any(),
    /**
     * Multipart upload — request body is `multipart/form-data` with a binary
     * `file` field and a `name` text field. Demonstrates `MultipartBody<T>`
     * + `Binary` working together to document multer-style endpoints. The
     * handler echoes the `name` field back; the binary `file` is parsed by
     * multer into `req.files` (not exercised in the response).
     * @param {import('express').Request<{}, unknown, import('@aller/express-swagger').MultipartBody<import('types').DeploymentBody>>} req
     * @param {import('express').Response<{ name: string }>} res
     */
    (req, res) => res.status(201).json({ name: req.body.name })
  );

  /**
   * Inline JSDoc typedef aliasing a library response — the typedef's status
   * literal should propagate into `statusByType` so a route typed with
   * `Response<InlineAcceptedResponse>` pins the success status to 202.
   *
   * @typedef {import('@aller/express-swagger').ApiResponse<UserRecord, 202>} InlineAcceptedResponse
   */
  app.post(
    '/users/:id/inline-accepted',
    /**
     * @param {import('express').Request<GetUserPathParams>} _req
     * @param {import('express').Response<InlineAcceptedResponse>} res
     */
    (_req, res) => res.status(202).json(/** @type {any} */ ({}))
  );

  /**
   * Inline JSDoc typedef aliasing a library *convenience* response — status
   * is reached by following the import-type qualifier through CreatedResponse's
   * heritage to `ApiResponse<T, 201>`, not via a literal on the typedef itself.
   *
   * @typedef {import('@aller/express-swagger').CreatedResponse<UserRecord>} InlineCreatedResponse
   */
  app.post(
    '/users/:id/inline-created',
    /**
     * @param {import('express').Request<GetUserPathParams>} _req
     * @param {import('express').Response<InlineCreatedResponse>} res
     */
    (_req, res) => res.status(201).json(/** @type {any} */ ({}))
  );

  // Identifier-bound route path — the path argument is a `const` reference
  // rather than a string literal, which exercises the resolveStaticString
  // identifier branch.
  const TEAPOTS_ROUTE_PATH = '/teapots';
  app.get(
    TEAPOTS_ROUTE_PATH,
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response} res
     * @throws {DeleteUserResponse} nothing to brew
     */
    (_req, res) => res.status(200).json({})
  );

  app.delete(
    '/cache/:key',
    /**
     * Library `NoContentResponse` used directly (no user-side alias) — the
     * 204 status should still flow off the type chain and the response
     * should be body-less, without a false-positive "unresolved" warn.
     * @param {import('express').Request<{ key: string }>} _req
     * @param {import('express').Response<import('@aller/express-swagger').NoContentResponse>} res
     */
    (_req, res) => res.status(204).end()
  );

  app.delete(
    '/cache/direct/:key',
    /**
     * Bare `res: NoContentResponse` (no `Response<…>` wrapper) — the library
     * recognizes it as a response slot via chain walk.
     * @param {import('express').Request<{ key: string }>} _req
     * @param {import('@aller/express-swagger').NoContentResponse} res
     */
    (_req, res) => res.status(204).end()
  );

  app.delete(
    '/users/:id',
    /**
     * @param {import('express').Request<GetUserPathParams>} _req
     * @param {import('express').Response<DeleteUserResponse>} res
     * @throws {GetUserNotFoundResponse}
     * @throws {import('types').DeleteUserBadRequestResponse}
     */
    (_req, res) => {
      res.status(204).end();
    }
  );

  app.get(
    '/accounts',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response<import('types').AccountMap>} res a dictionary of subscriptions keyed by account id
     */
    (_req, res) => {
      res.status(200).json(/** @type {any} */ ({}));
    }
  );

  app.get(
    '/metadata',
    /**
     * @param {import('express').Request} _req
     * @param {import('express').Response<Record<string, any>>} res free-form key/value bag
     */
    (_req, res) => {
      res.status(200).json({});
    }
  );
}
