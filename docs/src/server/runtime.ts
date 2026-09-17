/**
 * The composition root for server-side work.
 *
 * Everything that talks to the API goes through here, so there is exactly one
 * place that decides how a session is read, how a call is authorised and whose
 * address is forwarded.
 */

import {
  getRequestHeader,
  getRequestHost,
  getRequestIP,
} from "@tanstack/react-start/server";

import {
  DocgenTokenCache,
  RefreshCoordinator,
  SessionManager,
} from "../application/session.ts";
import type { CallContext } from "../application/ports.ts";
import { systemClock } from "../application/ports.ts";
import { ValidationError } from "../domain/errors.ts";
import { getConfig } from "../infrastructure/config.ts";
import {
  createDocgenClient,
  type DocgenClient,
} from "../infrastructure/api/docgen-client.ts";
import { createIdentityClient } from "../infrastructure/api/identity-client.ts";
import type { IdentityGateway } from "../application/ports.ts";
import { createCookieSessionStore } from "../infrastructure/session/cookie-session-store.ts";

/**
 * Process-wide, and deliberately so: sharing one rotation between concurrent
 * requests only works if they share the coordinator. A per-request instance
 * would defeat the whole point and let the API see a replayed refresh token.
 */
const coordinator = new RefreshCoordinator();

/**
 * Process-wide as well: a five-minute token is worth reusing across the
 * requests of one session, and it never leaves this process.
 */
const docgenTokens = new DocgenTokenCache(systemClock);

let client: DocgenClient | null = null;
let identityClient: IdentityGateway | null = null;

/**
 * Built lazily. Reading configuration at module load would throw during the
 * build, where no environment is set.
 */
export function docgen(): DocgenClient {
  client ??= createDocgenClient({ baseUrl: getConfig().apiUrl });
  return client;
}

/** The Imobiliary platform, which owns identity. Built lazily, as above. */
export function identity(): IdentityGateway {
  identityClient ??= createIdentityClient({ baseUrl: getConfig().identityApiUrl });
  return identityClient;
}

/** A session manager bound to the current request's cookie. */
export function sessions(): SessionManager {
  return new SessionManager({
    identity: identity(),
    store: createCookieSessionStore(),
    coordinator,
    tokens: docgenTokens,
    clock: systemClock,
  });
}

/**
 * What every call to the API carries beyond its arguments.
 *
 * The client address is forwarded so the API's per-IP rate limit still measures
 * real clients rather than this server. `X-Forwarded-For` is only read when the
 * deployment says a trusted proxy sets it — otherwise the socket address is the
 * truth and the header is forgeable.
 */
export function callContext(): CallContext {
  const clientIp = getRequestIP({
    xForwardedFor: getConfig().trustProxyHeaders,
  });
  return clientIp === undefined ? {} : { clientIp };
}

/**
 * Rejects a cross-site request before it can act on the session cookie.
 *
 * `SameSite=Lax` already blocks the classic cross-site form POST, but it is one
 * mechanism in one place; comparing the Origin to the host is a second, cheap
 * check that does not depend on the browser having got the first one right.
 *
 * A missing Origin is rejected rather than waved through: every browser sends
 * it on the fetch requests server functions are invoked with, so its absence
 * means the caller is not the app.
 */
export function assertSameOrigin(): void {
  const origin = getRequestHeader("origin");
  const host = getRequestHost();

  if (origin === undefined || origin === "") {
    throw new ValidationError([
      { field: "request", message: "Requisição sem origem." },
    ]);
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ValidationError([
      { field: "request", message: "Origem inválida." },
    ]);
  }

  // A configured origin wins over the Host header, which a proxy in front
  // may have rewritten.
  const { trustedOrigin } = getConfig();
  const expected = trustedOrigin === null ? host : new URL(trustedOrigin).host;

  if (originHost !== expected) {
    throw new ValidationError([
      { field: "request", message: "Origem não permitida." },
    ]);
  }
}
