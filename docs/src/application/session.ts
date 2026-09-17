import { AuthenticationError } from "../domain/errors.ts";
import type { Session } from "../domain/user.ts";
import type {
  CallContext,
  Clock,
  DocgenToken,
  IdentityGateway,
  SessionStore,
} from "./ports.ts";

/**
 * Shares one in-flight refresh between concurrent callers holding the same
 * secret.
 *
 * This exists because of how the Imobiliary platform defends stolen sessions: a
 * refresh token may be exchanged exactly once, and presenting a consumed one is
 * treated as evidence of theft — it revokes **every** session of that account.
 * Two requests from the same browser whose access token expires at the same
 * moment would both try to rotate the same secret, and the loser would take the
 * user's session down with it.
 *
 * Keying on the secret itself is what makes this correct: two requests share a
 * rotation exactly when they would otherwise have collided.
 *
 * A rotation is also remembered for a short grace period after it finishes.
 * Two tabs reloading together send requests that each carry the cookie as it
 * was when the tab asked; the second can reach this process just after the
 * first rotation completed, still holding the consumed secret. Without the
 * grace period it would present that secret to the API and revoke the chain
 * (seen on 2026-09-16). The remembered result is only the new session, kept
 * in memory, and it is dropped once the period ends.
 */
export class RefreshCoordinator {
  readonly #inFlight = new Map<string, Promise<Session>>();
  readonly #recent = new Map<string, { readonly session: Session; readonly at: number }>();
  readonly #now: () => number;
  readonly #graceMs: number;

  constructor(options: { now?: () => number; graceMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#graceMs = options.graceMs ?? ROTATION_GRACE_MS;
  }

  async run(
    refreshToken: string,
    refresh: () => Promise<Session>,
  ): Promise<Session> {
    this.#sweep();
    const recent = this.#recent.get(refreshToken);
    if (recent) return recent.session;

    const existing = this.#inFlight.get(refreshToken);
    if (existing) return existing;

    const attempt = refresh()
      .then((session) => {
        this.#recent.set(refreshToken, { session, at: this.#now() });
        return session;
      })
      .finally(() => {
        this.#inFlight.delete(refreshToken);
      });

    this.#inFlight.set(refreshToken, attempt);
    return attempt;
  }

  /** How many rotations are in flight. For tests and diagnostics. */
  get pending(): number {
    return this.#inFlight.size;
  }

  /** Forgets rotations older than the grace period. Map order is insertion order. */
  #sweep(): void {
    const cutoff = this.#now() - this.#graceMs;
    for (const [token, entry] of this.#recent) {
      if (entry.at > cutoff) break;
      this.#recent.delete(token);
    }
  }
}

/**
 * How long a finished rotation answers for the secret it consumed. Long enough
 * for requests a browser sent together, short enough that the new session is
 * not kept around.
 */
export const ROTATION_GRACE_MS = 10_000;

/**
 * How long before a token actually expires it is treated as expired.
 *
 * Without this margin a token that passes the check here can still be rejected
 * moments later, in the time the request spends in flight.
 */
const EXPIRY_SKEW_MS = 30_000;

/**
 * Keeps the short document-service tokens in memory while they last.
 *
 * A token is minted per session and lasts five minutes, so without a cache
 * every screen would spend a round trip on the platform before touching the
 * document service. It holds credentials, so it lives only in memory, is keyed
 * by account and office, and is dropped the moment the service refuses it.
 */
export class DocgenTokenCache {
  readonly #tokens = new Map<string, DocgenToken>();
  readonly #clock: Clock;
  readonly #skewMs: number;

  constructor(clock: Clock, options: { skewMs?: number } = {}) {
    this.#clock = clock;
    this.#skewMs = options.skewMs ?? EXPIRY_SKEW_MS;
  }

  async token(key: string, mint: () => Promise<DocgenToken>): Promise<string> {
    const held = this.#tokens.get(key);
    if (held !== undefined && !this.#isSpent(held)) return held.token;

    const minted = await mint();
    this.#tokens.set(key, minted);
    return minted.token;
  }

  /** Forgets a token, so the next call mints one. */
  forget(key: string): void {
    this.#tokens.delete(key);
  }

  #isSpent(token: DocgenToken): boolean {
    return (
      token.expiresAt.getTime() - this.#skewMs <= this.#clock.now().getTime()
    );
  }
}

export interface SessionManagerDeps {
  readonly identity: IdentityGateway;
  readonly store: SessionStore;
  readonly coordinator: RefreshCoordinator;
  readonly tokens: DocgenTokenCache;
  readonly clock: Clock;
}

/**
 * Owns the session: reads it, keeps it fresh, mints the token the document
 * service is called with, and ends the session when it can no longer be
 * recovered.
 *
 * Everything that needs an authenticated call goes through `authorize`, so
 * there is no path that forgets to refresh, forgets to persist a rotated token,
 * or sends the platform's own access token to the document service.
 */
export class SessionManager {
  readonly #identity: IdentityGateway;
  readonly #store: SessionStore;
  readonly #coordinator: RefreshCoordinator;
  readonly #tokens: DocgenTokenCache;
  readonly #clock: Clock;

  constructor(deps: SessionManagerDeps) {
    this.#identity = deps.identity;
    this.#store = deps.store;
    this.#coordinator = deps.coordinator;
    this.#tokens = deps.tokens;
    this.#clock = deps.clock;
  }

  /** The stored session, or null when there is none. */
  async current(): Promise<Session | null> {
    return this.#store.read();
  }

  /**
   * Runs a call to the document service with a token minted for this session,
   * refreshing the session first if its access token is spent and once more if
   * the service rejects what was sent.
   *
   * The second attempt covers the case where the token was refused rather than
   * merely expired — a clock difference, or a session ended elsewhere. If that
   * attempt also fails, the session is unrecoverable and is cleared, so the
   * user is sent to sign in rather than looping.
   */
  async authorize<T>(
    ctx: CallContext,
    run: (ctx: CallContext) => Promise<T>,
  ): Promise<T> {
    let session = await this.#store.read();
    if (session === null) {
      throw new AuthenticationError("no session");
    }

    if (this.#isExpired(session)) {
      session = await this.#rotate(session);
    }

    try {
      return await run({ ...ctx, accessToken: await this.#docgenToken(ctx, session) });
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error;

      // Either the minted token was refused or the platform refused to mint
      // one. Both are answered the same way: drop what is held, rotate, and
      // try once with a token minted from the new session.
      this.#tokens.forget(keyOf(session));
      const rotated = await this.#rotate(session);
      try {
        return await run({ ...ctx, accessToken: await this.#docgenToken(ctx, rotated) });
      } catch (retried) {
        // A refused token minted from a session that had just been refreshed is
        // not a stale credential: the session no longer buys access to the
        // document service at all, so it is cleared and the person signs in
        // again rather than watching every screen fail.
        if (retried instanceof AuthenticationError) {
          this.#tokens.forget(keyOf(rotated));
          await this.#store.clear();
        }
        throw retried;
      }
    }
  }

  async signIn(session: Session): Promise<void> {
    this.#tokens.forget(keyOf(session));
    await this.#store.write(session);
  }

  /**
   * Ends the session both here and at the platform, then clears the cookie
   * regardless — if the call fails, the user still wanted to be signed out and
   * the local session must not survive.
   */
  async signOut(ctx: CallContext): Promise<void> {
    const session = await this.#store.read();

    try {
      if (session !== null) {
        this.#tokens.forget(keyOf(session));
        await this.#identity.logout(ctx, session.refreshToken);
      }
    } finally {
      await this.#store.clear();
    }
  }

  /** A token for the document service, minted from the platform's session. */
  async #docgenToken(ctx: CallContext, session: Session): Promise<string> {
    return this.#tokens.token(keyOf(session), () =>
      this.#identity.docgenToken({ ...ctx, accessToken: session.accessToken }),
    );
  }

  #isExpired(session: Session): boolean {
    return (
      session.accessExpiresAt.getTime() - EXPIRY_SKEW_MS <=
      this.#clock.now().getTime()
    );
  }

  /** Rotates the pair, persists the result, and clears the session on failure. */
  async #rotate(session: Session): Promise<Session> {
    try {
      const rotated = await this.#coordinator.run(session.refreshToken, () =>
        this.#identity.refresh({}, session.refreshToken),
      );
      await this.#store.write(rotated);
      return rotated;
    } catch (error) {
      // A refresh that fails cannot be retried: the secret is either unknown,
      // expired, revoked, or has just taken the whole chain down with it.
      await this.#store.clear();
      throw error instanceof AuthenticationError
        ? error
        : new AuthenticationError("session could not be refreshed");
    }
  }
}

/**
 * A minted token belongs to one account in one office: the office decides what
 * the document service shows, so a session that moved office must not reuse the
 * token of the previous one.
 */
function keyOf(session: Session): string {
  return `${session.user.id}:${session.organization.id}`;
}
