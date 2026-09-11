import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { AuthenticationError, UnexpectedError } from "../domain/errors.ts";
import type { Session, User } from "../domain/user.ts";
import type { AuthGateway, CallContext, Clock, SessionStore } from "./ports.ts";
import { RefreshCoordinator, SessionManager } from "./session.ts";

const user: User = {
  id: "01a08374-3567-79e9-83a1-ab0c71a3f88e",
  email: "ada@example.com",
  name: "Ada Lovelace",
  createdAt: new Date("2026-09-01T00:00:00Z"),
};

const now = new Date("2026-09-09T12:00:00Z");

function sessionExpiring(minutes: number, suffix = "1"): Session {
  return {
    accessToken: `access-${suffix}`,
    accessExpiresAt: new Date(now.getTime() + minutes * 60_000),
    refreshToken: `refresh-${suffix}`,
    refreshExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
    user,
  };
}

/** An in-memory stand-in for the encrypted cookie. */
class FakeStore implements SessionStore {
  session: Session | null;
  clears = 0;

  constructor(session: Session | null) {
    this.session = session;
  }

  read(): Promise<Session | null> {
    return Promise.resolve(this.session);
  }

  write(session: Session): Promise<void> {
    this.session = session;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.clears += 1;
    this.session = null;
    return Promise.resolve();
  }
}

/** Records what was asked of the API and lets a test choose the answers. */
class FakeAuth implements AuthGateway {
  // Present to satisfy the port. SessionManager never reaches for any of them.
  async deleteAccount(): Promise<void> {}
  async changePassword(): Promise<never> {
    throw new Error("not used by these tests");
  }
  async requestPasswordReset(): Promise<void> {}
  async resetPassword(): Promise<void> {}
  async exportAccount(): Promise<never> {
    throw new Error("not used by these tests");
  }

  refreshCalls = 0;
  logoutCalls = 0;
  refreshDelayMs = 0;
  refreshFails: Error | null = null;

  register(): Promise<void> {
    throw new Error("not used");
  }

  login(): Promise<Session> {
    throw new Error("not used");
  }

  currentUser(): Promise<User> {
    return Promise.resolve(user);
  }

  async refresh(_ctx: CallContext, _refreshToken: string): Promise<Session> {
    this.refreshCalls += 1;
    if (this.refreshDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
    }
    if (this.refreshFails) throw this.refreshFails;
    return sessionExpiring(15, "2");
  }

  logout(): Promise<void> {
    this.logoutCalls += 1;
    return Promise.resolve();
  }
}

const clock: Clock = { now: () => now };

describe("RefreshCoordinator", () => {
  it("shares one rotation between callers holding the same secret", async () => {
    const coordinator = new RefreshCoordinator();
    let runs = 0;

    const refresh = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return sessionExpiring(15, "2");
    };

    const [a, b] = await Promise.all([
      coordinator.run("refresh-1", refresh),
      coordinator.run("refresh-1", refresh),
    ]);

    assert.equal(runs, 1, "the secret was exchanged more than once");
    assert.equal(a, b, "callers received different sessions");
    assert.equal(coordinator.pending, 0, "the entry was not released");
  });

  it("keeps different secrets independent", async () => {
    const coordinator = new RefreshCoordinator();
    let runs = 0;

    const refresh = async () => {
      runs += 1;
      return sessionExpiring(15, "2");
    };

    await Promise.all([
      coordinator.run("refresh-a", refresh),
      coordinator.run("refresh-b", refresh),
    ]);

    assert.equal(runs, 2);
  });

  it("releases the entry after a failure so a later attempt can proceed", async () => {
    const coordinator = new RefreshCoordinator();

    await assert.rejects(
      coordinator.run("refresh-1", () =>
        Promise.reject(new AuthenticationError()),
      ),
    );
    assert.equal(coordinator.pending, 0);
  });
});

describe("SessionManager", () => {
  let auth: FakeAuth;
  let store: FakeStore;
  let manager: SessionManager;

  function build(session: Session | null) {
    auth = new FakeAuth();
    store = new FakeStore(session);
    manager = new SessionManager({
      auth,
      store,
      coordinator: new RefreshCoordinator(),
      clock,
    });
  }

  beforeEach(() => build(sessionExpiring(15)));

  it("passes the access token to the call", async () => {
    const seen: (string | undefined)[] = [];

    await manager.authorize({}, async (ctx) => {
      seen.push(ctx.accessToken);
      return "done";
    });

    assert.deepEqual(seen, ["access-1"]);
    assert.equal(auth.refreshCalls, 0);
  });

  it("keeps the caller's client address", async () => {
    let forwarded: string | undefined;

    await manager.authorize({ clientIp: "203.0.113.7" }, async (ctx) => {
      forwarded = ctx.clientIp;
    });

    assert.equal(forwarded, "203.0.113.7");
  });

  it("refuses when there is no session", async () => {
    build(null);
    await assert.rejects(
      manager.authorize({}, async () => "unreachable"),
      AuthenticationError,
    );
  });

  // The margin matters: a token valid for another ten seconds can still be
  // rejected by the API in the time the request spends in flight.
  it("refreshes a token that is about to expire", async () => {
    build(sessionExpiring(0.25));

    const token = await manager.authorize({}, async (ctx) => ctx.accessToken);

    assert.equal(auth.refreshCalls, 1);
    assert.equal(token, "access-2");
    assert.equal(store.session?.refreshToken, "refresh-2");
  });

  /**
   * The behaviour this whole design exists for. Without single-flight, both
   * requests would exchange the same secret, the API would read the second as a
   * replay, and it would revoke every session of the account.
   */
  it("exchanges the secret once when two calls race an expired token", async () => {
    build(sessionExpiring(-1));
    auth.refreshDelayMs = 15;

    const tokens = await Promise.all([
      manager.authorize({}, async (ctx) => ctx.accessToken),
      manager.authorize({}, async (ctx) => ctx.accessToken),
    ]);

    assert.equal(auth.refreshCalls, 1, "the refresh secret was replayed");
    assert.deepEqual(tokens, ["access-2", "access-2"]);
  });

  it("retries once when the API rejects a token it had accepted", async () => {
    let attempts = 0;

    const token = await manager.authorize({}, async (ctx) => {
      attempts += 1;
      if (attempts === 1) throw new AuthenticationError();
      return ctx.accessToken;
    });

    assert.equal(attempts, 2);
    assert.equal(auth.refreshCalls, 1);
    assert.equal(token, "access-2");
  });

  it("does not retry an error that is not about authentication", async () => {
    let attempts = 0;

    await assert.rejects(
      manager.authorize({}, async () => {
        attempts += 1;
        throw new UnexpectedError("the API fell over");
      }),
      UnexpectedError,
    );

    assert.equal(attempts, 1, "a failing call was repeated");
    assert.equal(auth.refreshCalls, 0);
  });

  it("clears the session when the refresh itself fails", async () => {
    build(sessionExpiring(-1));
    auth.refreshFails = new AuthenticationError();

    await assert.rejects(
      manager.authorize({}, async () => "unreachable"),
      AuthenticationError,
    );

    assert.equal(store.session, null);
    assert.equal(store.clears, 1);
  });

  it("signs out at the API and locally", async () => {
    await manager.signOut({});

    assert.equal(auth.logoutCalls, 1);
    assert.equal(store.session, null);
  });

  // Whatever the API says, the user asked to be signed out, so the local
  // session must not survive the attempt.
  it("clears the session even when signing out at the API fails", async () => {
    auth.logout = () => Promise.reject(new UnexpectedError("network down"));

    await assert.rejects(manager.signOut({}), UnexpectedError);
    assert.equal(store.session, null);
  });
});
