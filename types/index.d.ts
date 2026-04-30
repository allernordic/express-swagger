declare module '@aller/express-swagger' {
	/**
	 * Build the OpenAPI document for an Express app. Callers choose how to serve
	 * it — e.g. write it to disk and expose via `express.static`, or wrap in a
	 * route handler for on-demand delivery.
	 *
	 * */
	export function buildSwaggerDocument(app: import("express").Express, options?: {
		tsconfig?: string | URL;
		security?: Record<string, any>;
	}): Promise<Record<string, any>>;
	export type ApiResponse<ResBody = unknown, StatusCode extends number = number> = ApiResponse_1<ResBody, StatusCode>;
	export type ErrorResponse<T, StatusCode extends number = number> = ErrorResponse_1<T, StatusCode>;
	export type BadRequestResponse<T> = BadRequestResponse_1<T>;
	export type UnauthorizedResponse<T> = UnauthorizedResponse_1<T>;
	export type ForbiddenResponse<T> = ForbiddenResponse_1<T>;
	export type NotFoundResponse<T> = NotFoundResponse_1<T>;
	export type ConflictResponse<T> = ConflictResponse_1<T>;
	export type InternalServerErrorResponse<T> = InternalServerErrorResponse_1<T>;
	export type BadGatewayResponse<T> = BadGatewayResponse_1<T>;
	export type CreatedResponse<T> = CreatedResponse_1<T>;
	export type NoContentResponse = NoContentResponse_1;
	export type ThrowsEntry = ThrowsEntry_1;
	export type SlotInfo = SlotInfo_1;
	export type RouteMetadata = RouteMetadata_1;
	export type SecurityRequirement = SecurityRequirement_1;
	export type LoadedTsconfig = LoadedTsconfig_1;
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
  interface ApiResponse_1<ResBody = unknown, StatusCode extends number = number> {
	body: ResBody;
	statusCode: StatusCode;
  }

  /**
   * Base error response. Inherits from the library `ApiResponse` so success
   * and error variants share one structural root — declare your own error
   * types with `extends ErrorResponse<T, 418>` and the generated OpenAPI
   * document will honor the status without a registry update.
   */
  interface ErrorResponse_1<T, StatusCode extends number = number> extends ApiResponse_1<T, StatusCode> {}

  /**
   * Bad request response
   */
  interface BadRequestResponse_1<T> extends ErrorResponse_1<T, 400> {}

  /**
   * Unauthorized response
   */
  interface UnauthorizedResponse_1<T> extends ErrorResponse_1<T, 401> {}

  /**
   * Forbidden response
   */
  interface ForbiddenResponse_1<T> extends ErrorResponse_1<T, 403> {}

  /**
   * Not found response
   */
  interface NotFoundResponse_1<T> extends ErrorResponse_1<T, 404> {}

  /**
   * Conflict response
   */
  interface ConflictResponse_1<T> extends ErrorResponse_1<T, 409> {}

  /**
   * Internal server error response
   */
  interface InternalServerErrorResponse_1<T> extends ErrorResponse_1<T, 500> {}

  /**
   * Bad gateway response
   */
  interface BadGatewayResponse_1<T> extends ErrorResponse_1<T, 502> {}

  /**
   * Created response — extends `ApiResponse<T, 201>` so the status flows off
   * the chain like every other status type. Routes typed with this return
   * `201` with `T` as the wire body.
   */
  interface CreatedResponse_1<T> extends ApiResponse_1<T, 201> {}

  /**
   * No-content response — extends `ApiResponse<never, 204>`. Routes typed
   * with this return `204` and no body; using `never` for the body keeps the
   * generated OpenAPI response without a `content` block.
   */
  interface NoContentResponse_1 extends ApiResponse_1<never, 204> {}

  /**
   * One `@throws {…}` entry collected from a handler's JSDoc — captures the
   * type name and (when applicable) the resolved status / inline schema.
   */
  interface ThrowsEntry_1 {
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
  interface SlotInfo_1 {
	/** Identifier text when the slot was a bare named type (or a single-qualifier import-type). */
	name?: string;
	/** Original AST node — used to resolve inline object literals via the TypeChecker. */
	typeNode?: any;
	/** Inline schema for non-named slots, resolved from `typeNode`. */
	schema?: Record<string, any>;
	/** HTTP status walked off the slot's type chain (response slots only). */
	statusFromChain?: string;
  }

  /** Per-handler metadata pulled out of the `@param` / `@throws` / `@tag` / `@security` JSDoc tags. */
  interface RouteMetadata_1 {
	params?: SlotInfo_1;
	request?: SlotInfo_1;
	response?: SlotInfo_1;
	query?: SlotInfo_1;
	throws?: ThrowsEntry_1[];
	/** Free text after `@param {Request<…>} req <description>`. */
	requestDescription?: string;
	/** Free text after `@param {Response<…>} res <description>`. */
	responseDescription?: string;
	/** Literal status code from `ApiResponse<Body, NNN>`. */
	responseStatus?: string;
  }

  /** Per-route `@security <scheme> [arg …]` entry. */
  interface SecurityRequirement_1 {
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
  interface LoadedTsconfig_1 {
	schemas: Record<string, object>;
	jsdocThrows: Map<string, ThrowsEntry_1[]>;
	usePrefixes: string[];
	privateRoutes: Set<string>;
	descriptions: Map<string, string>;
	statusByType: Map<string, string>;
	handlerTypes: Map<string, RouteMetadata_1>;
	tags: Map<string, string[]>;
	deprecations: Map<string, string>;
	security: Map<string, SecurityRequirement_1[]>;
	title: string | null;
  }

	export {};
}

//# sourceMappingURL=index.d.ts.map