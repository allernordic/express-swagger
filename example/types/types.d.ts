import type {
  BadRequestResponse,
  ConflictResponse,
  CreatedResponse,
  ErrorResponse,
  ForbiddenResponse,
  InternalServerErrorResponse,
  NoContentResponse,
  NotFoundResponse,
  UnauthorizedResponse,
} from '@aller/express-swagger';

export interface User {
  /** Stable opaque identifier */
  id: string;
  /** Full display name */
  name: string;
  /** Email address — uniqueness not enforced here */
  email: string;
  /** Optional age in years */
  age?: number;
}

export interface UserRecord extends User {
  /** When the record was first persisted */
  createdAt: Date;
  /** Free-form metadata bag */
  meta: any;
}

export interface CreateUserRequest {
  name: string;
  email: string;
  age?: number;
  verified: boolean;
  referralCode?: bigint;
}

export type CreateUserResponse = CreatedResponse<UserRecord>;

export type GetUserResponse = UserRecord;

export type DeleteUserResponse = NoContentResponse;

export interface CreateNoteRequest {
  title: string;
  body: string;
}

export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  createdAt: Date;
}

export type CreateNoteResponse = CreatedResponse<NoteRecord>;

export interface GetUserPathParams {
  id: number;
}

export interface ErrorResponseBody {
  error: string;
}

export interface ValidationErrorBody {
  errors: { field: string; message: string }[];
}

export interface Bar {
  id: string;
  weight: number;
  // Non-literal mixed-primitive union — exercises the `anyOf` branch in
  // typeToSchema (the literal-collapse helper bails out when members aren't
  // all literals).
  extra?: string | number;
}

// Demonstrates pulling the body type from a JavaScript Error subclass via
// indexed access. The library walks `BadRequestError['body']` through the
// TypeChecker, which resolves it to `ValidationErrorBody`.
export type CreateNoteBadRequestResponse = BadRequestResponse<import('../errors.js').BadRequestError['body']>;

export type ListUsersResponse = GetUserResponse[];

export enum UserStatus {
  Active = 'active',
  Inactive = 'inactive',
  Banned = 'banned',
}

/**
 * An enum whose members carry no initializer. TypeScript auto-assigns numeric
 * values (0, 1, 2, …), but for API documentation the member names are far
 * more useful — the library emits those instead.
 */
export enum Direction {
  Up,
  Down,
  Left,
  Right,
}

export interface ListUsersQuery {
  search?: string;
  limit: number;
  sort?: 'asc' | 'desc';
  roles?: ('admin' | 'user' | 'guest')[];
  status?: UserStatus;
  statuses?: UserStatus[];
  direction?: Direction;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
}

export type GetUserNotFoundResponse = NotFoundResponse<ErrorResponseBody>;

export type ListUsersBadRequestResponse = BadRequestResponse<ErrorResponseBody>;

export interface DeleteUserBadRequestResponse extends BadRequestResponse<ErrorResponseBody> {}

// Two-hop type alias chain — exercises the followIdentifier walk for type aliases.
type AliasedBadRequest = BadRequestResponse<ErrorResponseBody>;
export type LoginBadRequestResponse = AliasedBadRequest;

// Two-hop interface heritage chain — exercises the followIdentifier walk for extends clauses.
interface IntermediateNotFound extends NotFoundResponse<ErrorResponseBody> {}
export interface CreateUserNotFoundResponse extends IntermediateNotFound {}

export type CreateUserConflictResponse = ConflictResponse<ErrorResponseBody>;

// User-defined error type whose status code lives entirely on the type
// chain — exercises the `extends ErrorResponse<T, N>` literal-status path.
export interface TeapotResponse<T> extends ErrorResponse<T, 418> {}
export type CreateUserTeapotResponse = TeapotResponse<ErrorResponseBody>;

// Type aliases whose RHS is the library `ErrorResponse<Body, NNN>` directly —
// exercises the `inferFromTypeNode` literal-status branches for both the
// bare-identifier form and the `import(...)`-qualified form.
export type DirectTeapotResponse = ErrorResponse<ErrorResponseBody, 418>;
export type ImportedLegalReasonsResponse = import('@aller/express-swagger').ErrorResponse<ErrorResponseBody, 451>;

export type CreateUserInternalServerErrorResponse = InternalServerErrorResponse<ErrorResponseBody>;

export type LoginUnauthorizedResponse = UnauthorizedResponse<ErrorResponseBody>;

export type GetUserForbiddenResponse = ForbiddenResponse<ErrorResponseBody>;

// Un-exported self-referential interface — it's not in knownNames, so a
// property of this type must be inlined rather than $ref'd. The library
// must detect the cycle when walking the object shape.
interface RecursiveNode {
  next: RecursiveNode;
}

export interface RecursiveResponse {
  value: string;
  node: RecursiveNode;
}

// Deprecated wrapper-object types. `Number` / `String` / `Boolean` should be
// coerced to their primitive equivalents; `Symbol` / `Object` properties get
// dropped from the schema entirely (their structural shape is the wrapper's
// methods, which are useless for API documentation). The lowercase `symbol`
// primitive doesn't serialize to JSON either — same drop treatment.
// eslint-disable-next-line @typescript-eslint/ban-types
export interface DeprecatedWrappers {
  num: Number;
  str: String;
  bool: Boolean;
  sym: Symbol;
  obj: Object;
  symPrim: symbol;
}
