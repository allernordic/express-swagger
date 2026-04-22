/**
 * Library-specific response marker. The two template parameters carry the
 * wire body type and the HTTP status code — annotate handlers as
 * `ApiResponse<Body, 201>` to override the default success status, or
 * extend `ApiResponse` to declare custom error types. The shape is
 * intentionally minimal (no Express methods) so the library never has to
 * walk into node_modules type declarations to keep them out of emitted
 * schemas; the name (`ApiResponse`, not `Response`) avoids any collision
 * with Express's own `Response` type.
 */
export interface ApiResponse<ResBody = unknown, StatusCode extends number = number> {
  body: ResBody;
  statusCode: StatusCode;
}

/**
 * Base error response. Inherits from the library `ApiResponse` so success
 * and error variants share one structural root — declare your own error
 * types with `extends ErrorResponse<T, 418>` and the generated OpenAPI
 * document will honor the status without a registry update.
 */
export interface ErrorResponse<T, StatusCode extends number = number> extends ApiResponse<T, StatusCode> {}

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
