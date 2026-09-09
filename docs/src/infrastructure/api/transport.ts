/**
 * HTTP plumbing for the docgen API: one place that knows the API speaks HTTP,
 * and one place that turns a failed response into a domain error.
 *
 * This runs on the server only. A browser must never reach the API directly —
 * that is what keeps session tokens out of page JavaScript and lets the API sit
 * on a closed subdomain.
 */

import type { CallContext, Page } from "../../application/ports.ts";
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  RateLimitError,
  UnexpectedError,
  ValidationError,
  type FieldError,
} from "../../domain/errors.ts";

/** The envelope every failure from the API uses. */
interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    fields?: FieldError[];
  };
}

export interface TransportOptions {
  readonly baseUrl: string;
  /** Injected in tests; defaults to the platform's own fetch. */
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** How long one call may take before it is abandoned. */
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class Transport {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: TransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Sends a request and decodes a JSON response. */
  async json<T>(
    ctx: CallContext,
    method: string,
    path: string,
    payload?: unknown,
  ): Promise<T> {
    const response = await this.send(ctx, method, path, bodyOf(payload));

    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new UnexpectedError(`${method} ${path}: malformed response body`, {
        cause,
      });
    }
  }

  /** Sends a request and returns the raw response, throwing on failure. */
  async send(
    ctx: CallContext,
    method: string,
    path: string,
    init?: { body?: BodyInit; contentType?: string },
  ): Promise<Response> {
    const headers = new Headers({ accept: "application/json" });

    if (ctx.accessToken) {
      headers.set("authorization", `Bearer ${ctx.accessToken}`);
    }
    if (init?.contentType) {
      headers.set("content-type", init.contentType);
    }
    // FormData sets its own content-type, boundary included; setting one by
    // hand would produce a body the API cannot parse.

    // Forwarding the caller's address is what keeps the API's per-IP rate limit
    // meaningful. Without it every request arrives from this server and the
    // limit that stops password guessing becomes one bucket shared by everyone.
    if (ctx.clientIp) {
      headers.set("x-forwarded-for", ctx.clientIp);
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(init?.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        // A redirect from an internal API is never expected and following one
        // could send the bearer token somewhere it does not belong.
        redirect: "error",
      });
    } catch (cause) {
      throw new UnexpectedError(`${method} ${path}: request failed`, { cause });
    }

    if (!response.ok) {
      throw await toDomainError(response, method, path);
    }
    return response;
  }
}

function bodyOf(
  payload: unknown,
): { body?: BodyInit; contentType?: string } | undefined {
  if (payload === undefined) return undefined;
  if (payload instanceof FormData) return { body: payload };
  return { body: JSON.stringify(payload), contentType: "application/json" };
}

/**
 * Maps a failed response onto a domain error.
 *
 * The status decides. The API's prose message is never surfaced for a 5xx,
 * which would risk leaking internals to the user.
 */
async function toDomainError(
  response: Response,
  method: string,
  path: string,
): Promise<Error> {
  const body = await readErrorBody(response);
  const fields = body?.error?.fields ?? [];

  switch (response.status) {
    case 400:
      return new ValidationError(
        fields.length > 0
          ? fields
          : [{ field: "request", message: "Requisição inválida." }],
      );

    case 401:
      // Every cause collapses into one response by design — wrong password,
      // unknown account, expired token, revoked session, replayed refresh
      // secret. Do not try to tell them apart.
      return new AuthenticationError();

    case 404:
      return new NotFoundError();

    case 409:
      return new ConflictError();

    case 415:
      return new ValidationError([
        { field: "request", message: "Formato de envio não suportado." },
      ]);

    case 422:
      return new ValidationError(fields);

    case 429:
      return new RateLimitError(retryAfter(response));

    default:
      return new UnexpectedError(
        `${method} ${path}: API responded ${response.status}`,
      );
  }
}

async function readErrorBody(response: Response): Promise<ApiErrorBody | null> {
  try {
    return (await response.json()) as ApiErrorBody;
  } catch {
    // A missing or unparseable body is not itself worth reporting: the status
    // already carries the meaning.
    return null;
  }
}

/** Seconds to wait, defaulting to one when the header is absent or junk. */
function retryAfter(response: Response): number {
  const raw = response.headers.get("retry-after");
  const seconds = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
}

/** Reads the filename out of a Content-Disposition header. */
export function filenameFrom(header: string | null): string {
  const quoted = header?.match(/filename="([^"]*)"/);
  const name = quoted?.[1];
  return name === undefined || name === "" ? "documento.docx" : name;
}

export function pageQuery(page?: Page): string {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set("limit", String(page.limit));
  if (page?.offset !== undefined) params.set("offset", String(page.offset));

  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** Path segments carry user-supplied identifiers, so they are always escaped. */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}
