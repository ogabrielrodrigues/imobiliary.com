import { AuthenticationError } from "../domain/errors.ts";
import type { Session } from "../domain/user.ts";
import type {
  AuthGateway,
  CallContext,
  Clock,
  SessionStore,
} from "./ports.ts";

/**
 * Shares one in-flight refresh between concurrent callers holding the same
 * secret.
 *
 * This exists because of how the API defends stolen sessions: a refresh token
 * may be exchanged exactly once, and presenting a consumed one is treated as
 * evidence of theft — it revokes **every** session of that account. Two
 * requests from the same browser whose access token expires at the same moment
 * would both try to rotate the same secret, and the loser would take the user's
 * session down with it.
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
 * How long before an access token actually expires it is treated as expired.
 *
 * Without this margin a token that passes the check here can still be rejected
 * by the API moments later, in the time the request spends in flight.
 */
const EXPIRY_SKEW_MS = 30_000;

export interface SessionManagerDeps {
  readonly auth: AuthGateway;
  readonly store: SessionStore;
  readonly coordinator: RefreshCoordinator;
  readonly clock: Clock;
}

/**
 * Owns the session: reads it, keeps it fresh, and ends it when it can no longer
 * be recovered.
 *
 * Everything that needs an authenticated call goes through `authorize`, so
 * there is no path that forgets to refresh or forgets to persist a rotated
 * token.
 */
export class SessionManager {
  readonly #auth: AuthGateway;
  readonly #store: SessionStore;
  readonly #coordinator: RefreshCoordinator;
  readonly #clock: Clock;

  constructor(deps: SessionManagerDeps) {
    this.#auth = deps.auth;
    this.#store = deps.store;
    this.#coordinator = deps.coordinator;
    this.#clock = deps.clock;
  }

  /** The stored session, or null when there is none. */
  async current(): Promise<Session | null> {
    return this.#store.read();
  }

  /**
   * Runs an authenticated call, refreshing first if the access token is spent
   * and once more if the API rejects it anyway.
   *
   * The second attempt covers the case where the token was revoked rather than
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
      return await run({ ...ctx, accessToken: session.accessToken });
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error;

      const rotated = await this.#rotate(session);
      return run({ ...ctx, accessToken: rotated.accessToken });
    }
  }

  async signIn(session: Session): Promise<void> {
    await this.#store.write(session);
  }

  /**
   * Ends the session both here and at the API, then clears the cookie
   * regardless — if the API call fails, the user still wanted to be signed out
   * and the local session must not survive.
   */
  async signOut(ctx: CallContext): Promise<void> {
    const session = await this.#store.read();

    try {
      if (session !== null) {
        await this.#auth.logout(ctx, session.refreshToken);
      }
    } finally {
      await this.#store.clear();
    }
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
        this.#auth.refresh({}, session.refreshToken),
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
