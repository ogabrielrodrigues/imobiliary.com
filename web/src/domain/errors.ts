/**
 * Domain errors.
 *
 * These mirror the shapes the Imobiliary API returns, so the rest of the
 * platform can branch on meaning rather than on status codes. The API's `code`
 * field is stable and safe to switch on; its `message` is prose and is not.
 */

/** One field-level problem, named exactly as the API names it. */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** Base class for everything this layer throws, so a catch can narrow once. */
export abstract class DomainError extends Error {
  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The request was well formed but not acceptable.
 *
 * It carries every problem found rather than the first, because the API
 * reports them all at once and a form should light up all its bad fields in one
 * go rather than one round trip at a time.
 */
export class ValidationError extends DomainError {
  readonly fields: readonly FieldError[];

  constructor(fields: readonly FieldError[], message = "validation failed") {
    super(message);
    this.fields = fields;
  }

  /** Returns the first problem recorded against a field, if any. */
  messageFor(field: string): string | undefined {
    return this.fields.find((f) => f.field === field)?.message;
  }
}

/** No such resource — or none this account is allowed to see. */
export class NotFoundError extends DomainError {
  constructor(message = "resource not found") {
    super(message);
  }
}

/** The resource already exists; in practice, the email is taken. */
export class ConflictError extends DomainError {
  constructor(message = "resource already exists") {
    super(message);
  }
}

/**
 * Authentication failed.
 *
 * The API deliberately collapses several causes into one response — wrong
 * password, unknown account, expired token, revoked session, replayed refresh
 * secret — so that it never confirms which. This error keeps that property:
 * do not try to guess the cause from it.
 */
export class AuthenticationError extends DomainError {
  constructor(message = "authentication failed") {
    super(message);
  }
}

/**
 * The caller is signed in and may not do this.
 *
 * Distinct from authentication: signing in again would change nothing, so a
 * screen must not send the person to the sign-in form.
 */
export class PermissionError extends DomainError {
  constructor(message = "not allowed") {
    super(message);
  }
}

/**
 * The session is real but may only enrol a second factor.
 *
 * An administrator manages members, so the account that can do that carries a
 * second factor. Until it does, the session reaches the enrolment endpoints
 * and nothing else, and every screen sends the person to the setup.
 */
export class EnrollmentRequiredError extends DomainError {
  constructor(message = "second factor required before continuing") {
    super(message);
  }
}

/** Too many requests. */
export class RateLimitError extends DomainError {
  /** Whole seconds to wait, taken from the API's Retry-After header. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = "too many requests") {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Anything else: a 5xx, a malformed response, a network failure.
 *
 * Its message is for logs, never for the interface — showing it risks leaking
 * internals to the user.
 */
export class UnexpectedError extends DomainError {
  constructor(message = "unexpected error", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Builds a ValidationError for a single field, the common case in a form. */
export function fieldError(field: string, message: string): ValidationError {
  return new ValidationError([{ field, message }]);
}
