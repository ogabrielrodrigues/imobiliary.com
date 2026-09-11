/**
 * The session, kept in a sealed cookie.
 *
 * TanStack Start ships `useSession`, which encrypts and signs the cookie's
 * contents with a secret and marks it httpOnly. That is exactly the property
 * the design needs — page JavaScript never sees a token, so an XSS cannot lift
 * a session — so this wraps the framework's primitive rather than hand-rolling
 * the same thing with node:crypto.
 */

import { useSession } from "@tanstack/react-start/server";

import type { SessionStore } from "../../application/ports.ts";
import type { Session } from "../../domain/user.ts";
import { getConfig } from "../config.ts";

const COOKIE_NAME = "imobiliary_docs_session";

/**
 * How long the cookie, and the seal inside it, stay valid: 30 days.
 *
 * It matches the API default for DOCGEN_REFRESH_TTL, which is the longest
 * the session inside could be of any use anyway. Without it the cookie had
 * no expiry and its seal never lapsed, so a stolen copy stayed decryptable
 * forever and browsers that restore sessions kept it indefinitely. Change
 * both together.
 */
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * What actually goes in the cookie.
 *
 * Instants are stored as ISO strings because the cookie is JSON: a Date would
 * come back as a string anyway, and doing the conversion deliberately keeps the
 * revive step honest.
 */
interface StoredSession {
  accessToken?: string;
  accessExpiresAt?: string;
  refreshToken?: string;
  refreshExpiresAt?: string;
  user?: {
    id: string;
    email: string;
    name: string;
    createdAt: string;
  };
}

function sessionConfig() {
  const config = getConfig();

  return {
    name: COOKIE_NAME,
    password: config.sessionSecret,
    // Sets both the cookie Max-Age and the lifetime of the seal itself.
    maxAge: SESSION_MAX_AGE_SECONDS,
    cookie: {
      httpOnly: true,
      // Lax rather than Strict so that arriving from an external link keeps the
      // user signed in; it still blocks the cross-site POSTs that matter, and
      // every mutating server function checks the Origin on top of this.
      sameSite: "lax",
      path: "/",
      // Off in development, where the dev server speaks plain HTTP and a
      // Secure cookie would simply never be stored.
      secure: config.isProduction,
    },
  } as const;
}

export function createCookieSessionStore(): SessionStore {
  return {
    async read(): Promise<Session | null> {
      const session = await useSession<StoredSession>(sessionConfig());
      return revive(session.data);
    },

    async write(session: Session): Promise<void> {
      const store = await useSession<StoredSession>(sessionConfig());
      await store.update({
        accessToken: session.accessToken,
        accessExpiresAt: session.accessExpiresAt.toISOString(),
        refreshToken: session.refreshToken,
        refreshExpiresAt: session.refreshExpiresAt.toISOString(),
        user: {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          createdAt: session.user.createdAt.toISOString(),
        },
      });
    },

    async clear(): Promise<void> {
      const store = await useSession<StoredSession>(sessionConfig());
      await store.clear();
    },
  };
}

/**
 * Rebuilds a session from the cookie, returning null unless every part is
 * present.
 *
 * A partially written cookie is treated as no session at all rather than as a
 * broken one: there is nothing useful to do with half a session, and guessing
 * would produce requests that fail in confusing ways later.
 */
function revive(data: StoredSession): Session | null {
  const { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, user } =
    data;

  if (
    accessToken === undefined ||
    accessExpiresAt === undefined ||
    refreshToken === undefined ||
    refreshExpiresAt === undefined ||
    user === undefined
  ) {
    return null;
  }

  return {
    accessToken,
    accessExpiresAt: new Date(accessExpiresAt),
    refreshToken,
    refreshExpiresAt: new Date(refreshExpiresAt),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: new Date(user.createdAt),
    },
  };
}
