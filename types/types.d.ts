import type { Response as ExpressResponse } from 'express';

/**
 * Library-specific response marker. Extends Express's `Response<ResBody>` so
 * handlers typed `ApiResponse<Body, 201>` retain `.send` / `.json` / `.status`
 * etc. with `Body` flowing through to method signatures (so `_res.send({…})`
 * type-checks against the body shape). The three template parameters carry
 * the wire body type, HTTP status code, and (optional) media type — annotate
 * handlers as `ApiResponse<Body, 201>` to override the default success status,
 * `ApiResponse<Buffer, 200, 'image/png'>` to pin the response media type, or
 * extend `ApiResponse` to declare custom error / convenience types. The
 * library reads `StatusCode` and `MediaType` off the type-arg positions (the
 * inherited runtime `statusCode: number` is narrowed to the literal). The
 * schema walk short-circuits on the `ApiResponse` symbol before descending
 * into Express's `Response` chain, so inherited methods never leak into
 * emitted schemas.
 */
// `StatusCode` and `MediaType` are phantom type parameters — the library
// reads them off the type-arg positions via the TypeChecker. The `body`
// field is optional so Express's runtime `Response<X>` (which has no
// `body`) stays structurally assignable in the contravariant handler-
// parameter slot; the chain walk reads the body type via the matched
// ancestor's type-args, not via the property symbol.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface ApiResponse<
  ResBody = unknown,
  StatusCode extends number = number,
  MediaType extends string = 'application/json',
> extends ExpressResponse<ResBody> {
  body?: ResBody;
}

/**
 * Base error response. Inherits from the library `ApiResponse` so success
 * and error variants share one structural root — declare your own error
 * types with `extends ErrorResponse<T, 418>` and the generated OpenAPI
 * document will honor the status without a registry update.
 */
export interface ErrorResponse<T, StatusCode extends number = number, MediaType extends string = 'application/json'> extends ApiResponse<
  T,
  StatusCode,
  MediaType
> {}

/**
 * Bad request response
 */
export interface BadRequestResponse<T> extends ErrorResponse<T, 400> {}

/**
 * Unauthorized response
 */
export interface UnauthorizedResponse<T> extends ErrorResponse<T, 401> {}

/**
 * Forbidden response
 */
export interface ForbiddenResponse<T> extends ErrorResponse<T, 403> {}

/**
 * Not found response
 */
export interface NotFoundResponse<T> extends ErrorResponse<T, 404> {}

/**
 * Conflict response
 */
export interface ConflictResponse<T> extends ErrorResponse<T, 409> {}

/**
 * Internal server error response
 */
export interface InternalServerErrorResponse<T> extends ErrorResponse<T, 500> {}

/**
 * Bad gateway response
 */
export interface BadGatewayResponse<T> extends ErrorResponse<T, 502> {}

/**
 * Created response — extends `ApiResponse<T, 201>` so the status flows off
 * the chain like every other status type. Routes typed with this return
 * `201` with `T` as the wire body.
 */
export interface CreatedResponse<T> extends ApiResponse<T, 201> {}

/**
 * No-content response — extends `ApiResponse<never, 204>`. Routes typed
 * with this return `204` and no body; using `never` for the body keeps the
 * generated OpenAPI response without a `content` block.
 */
export interface NoContentResponse extends ApiResponse<never, 204> {}

/**
 * HTML response — extends `ApiResponse<T, 200, 'text/html'>`. The third
 * generic on `ApiResponse` pins the wire media type so handlers typed with
 * `Response<HtmlResponse<string>>` emit the response body under `text/html`.
 */
export interface HtmlResponse<T = string> extends ApiResponse<T, 200, 'text/html'> {}

/**
 * Brand for binary payload fields. A property typed `Binary` emits as
 * `{ type: 'string', format: 'binary' }` in the OpenAPI schema — the
 * standard representation for file uploads under `multipart/form-data` or
 * raw binary request/response bodies.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Binary {}

/**
 * Brand wrapper for `application/x-www-form-urlencoded` request bodies.
 * Wrap your payload type as `FormBody<T>` in the `Request<P, ResBody, ReqBody>`
 * slot to switch the emitted requestBody content key from `application/json`
 * to `application/x-www-form-urlencoded`. The library peels the wrapper and
 * documents `T` as the body schema.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type
export interface FormBody<T> {}

/**
 * Brand wrapper for `multipart/form-data` request bodies — the canonical
 * shape for file uploads (multer / busboy / formidable). Wrap your payload
 * type as `MultipartBody<T>` in the request body slot; combine with `Binary`
 * fields on `T` to mark which properties are uploaded files.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type
export interface MultipartBody<T> {}

/**
 * One `@throws {…}` entry collected from a handler's JSDoc — captures the
 * type name and (when applicable) the resolved status / inline schema.
 */
export interface ThrowsEntry {
  name: string;
  /** Free-text comment after `@throws {…}` — surfaces as the response description. */
  description?: string;
  /** Original AST node — used to resolve generic args for inline status-type throws. */
  typeNode?: any;
  /** Pre-resolved HTTP status when the throws targets a library status type directly. */
  status?: string;
  /** Inline body schema when no named alias is available to `$ref`. */
  inlineSchema?: Record<string, any>;
}

/** One slot of a `Request<…>` / `Response<…>` JSDoc generic. */
export interface SlotInfo {
  /** Identifier text when the slot was a bare named type (or a single-qualifier import-type). */
  name?: string;
  /** Original AST node — used to resolve inline object literals via the TypeChecker. */
  typeNode?: any;
  /** Inline schema for non-named slots, resolved from `typeNode`. */
  schema?: Record<string, any>;
  /** HTTP status walked off the slot's type chain (response slots only). */
  statusFromChain?: string;
  /** Wire content type when the slot was wrapped in `FormBody<T>` / `MultipartBody<T>`. */
  contentType?: string;
}

/** Per-handler metadata pulled out of the `@param` / `@throws` / `@tag` / `@security` JSDoc tags. */
export interface RouteMetadata {
  params?: SlotInfo;
  request?: SlotInfo;
  response?: SlotInfo;
  query?: SlotInfo;
  throws?: ThrowsEntry[];
  /** Free text after `@param {Request<…>} req <description>`. */
  requestDescription?: string;
  /** Free text after `@param {Response<…>} res <description>`. */
  responseDescription?: string;
  /** Literal status code from `ApiResponse<Body, NNN>`. */
  responseStatus?: string;
}

/** Per-route `@security <scheme> [arg …]` entry. */
export interface SecurityRequirement {
  name: string;
  scopes: string[];
  headerName?: string;
  openIdConnectUrl?: string;
}

/**
 * Everything `loadFromTsconfig` produces: schemas, route metadata, status
 * mappings, JSDoc-derived tag/throws/security maps, and the doc title.
 * `buildSwaggerDocument` consumes this contract whether the program was
 * loaded from a tsconfig or stubbed (`{}`-everywhere when no tsconfig is
 * passed).
 */
export interface LoadedTsconfig {
  schemas: Record<string, object>;
  jsdocThrows: Map<string, ThrowsEntry[]>;
  usePrefixes: string[];
  privateRoutes: Set<string>;
  descriptions: Map<string, string>;
  statusByType: Map<string, string>;
  handlerTypes: Map<string, RouteMetadata>;
  tags: Map<string, string[]>;
  deprecations: Map<string, string>;
  security: Map<string, SecurityRequirement[]>;
  title: string | null;
}
