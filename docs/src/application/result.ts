/**
 * The shape a server function answers with.
 *
 * Expected failures are returned, not thrown. A thrown error crosses the RPC
 * boundary as plain data — the class is gone by the time the browser sees it,
 * so `instanceof ValidationError` on the client would always be false and the
 * form would show a generic message instead of marking the bad field. Making
 * failure a value keeps it typed on both sides, and forces the interface to say
 * what it does for each kind rather than lumping them into one catch.
 *
 * Genuine bugs still throw: they are not part of anyone's contract.
 */

import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  type FieldError,
} from "../domain/errors.ts";

export type Failure =
  | { readonly kind: "validation"; readonly fields: readonly FieldError[] }
  | { readonly kind: "authentication" }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" }
  | { readonly kind: "rate_limit"; readonly retryAfterSeconds: number }
  | { readonly kind: "unexpected" };

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Failure };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failed<T>(failure: Failure): Result<T> {
  return { ok: false, failure };
}

/** Maps a domain error onto the serialisable shape. */
export function failureOf(error: unknown): Failure {
  if (error instanceof ValidationError) {
    return { kind: "validation", fields: error.fields };
  }
  if (error instanceof AuthenticationError) {
    return { kind: "authentication" };
  }
  if (error instanceof ConflictError) {
    return { kind: "conflict" };
  }
  if (error instanceof NotFoundError) {
    return { kind: "not_found" };
  }
  if (error instanceof RateLimitError) {
    return { kind: "rate_limit", retryAfterSeconds: error.retryAfterSeconds };
  }
  return { kind: "unexpected" };
}

/**
 * Runs an operation and turns an expected failure into a value.
 *
 * An unexpected error is logged here and reduced to `unexpected` — its message
 * may name internals and must never reach the browser, but losing it entirely
 * would leave nothing to debug with.
 */
export async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await run());
  } catch (error) {
    const failure = failureOf(error);
    if (failure.kind === "unexpected") {
      console.error("unexpected failure in a server function", error);
    }
    return failed(failure);
  }
}

/** The message to show against one field, if the failure names it. */
export function messageFor(
  failure: Failure | null,
  field: string,
): string | undefined {
  if (failure?.kind !== "validation") return undefined;
  return failure.fields.find((f) => f.field === field)?.message;
}

/**
 * The message to show above a form, for failures that belong to no field.
 *
 * Returns null when every problem is already marked on an input, so the form
 * does not repeat itself.
 */
export function summaryOf(failure: Failure | null): string | null {
  if (failure === null) return null;

  switch (failure.kind) {
    case "validation":
      // A problem the API blamed on the request as a whole has no input to
      // sit under, so it is shown at the top instead of being swallowed.
      return failure.fields.some((f) => f.field === "request")
        ? "Não foi possível processar a requisição."
        : null;

    case "authentication":
      return "E-mail ou senha incorretos.";

    case "conflict":
      return "Já existe uma conta com esse e-mail.";

    case "not_found":
      return "Não encontramos o que você procura.";

    case "rate_limit":
      return `Muitas tentativas. Tente novamente em ${failure.retryAfterSeconds} segundo${
        failure.retryAfterSeconds === 1 ? "" : "s"
      }.`;

    case "unexpected":
      return "Algo deu errado do nosso lado. Tente novamente em instantes.";
  }
}
