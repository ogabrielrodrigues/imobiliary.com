import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { AuthenticationError, UnexpectedError } from "../domain/errors.ts";
import type { Organization, Session, User } from "../domain/user.ts";
import type {
  CallContext,
  Clock,
  DocgenToken,
  IdentityGateway,
  SessionStore,
} from "./ports.ts";
import {
  DocgenTokenCache,
  RefreshCoordinator,
  SessionManager,
} from "./session.ts";

const user: User = {
  id: "01a08374-3567-79e9-83a1-ab0c71a3f88e",
  email: "ada@example.com",
  name: "Ada Lovelace",
  createdAt: new Date("2026-09-01T00:00:00Z"),
};

const organization: Organization = {
  id: "01a08374-3567-79e9-83a1-000000000001",
  name: "Central Imoveis",
};

const now = new Date("2026-09-09T12:00:00Z");

function sessionExpiring(minutes: number, suffix = "1"): Session {
  return {
    accessToken: `access-${suffix}`,
    accessExpiresAt: new Date(now.getTime() + minutes * 60_000),
    refreshToken: `refresh-${suffix}`,
    refreshExpiresAt: new Date(now.getTime() + 30 * 86_400_000),
    user,
    organization,
    role: "admin",
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

/**
 * Records what was asked of the platform and lets a test choose the answers.
 *
 * A minted token is named after the access token it was minted from, which is
 * what lets a test see that the token sent to the document service came from
 * the session the manager was holding at the time.
 */
class FakeIdentity implements IdentityGateway {
  refreshCalls = 0;
  logoutCalls = 0;
  tokenCalls = 0;
  refreshDelayMs = 0;
  refreshFails: Error | null = null;
  tokenFails: Error | null = null;

  signIn(): Promise<never> {
    throw new Error("not used by these tests");
  }

  completeSecondFactor(): Promise<never> {
    throw new Error("not used by these tests");
  }

  switchOrganization(): Promise<never> {
    throw new Error("not used by these tests");
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

  docgenToken(ctx: CallContext): Promise<DocgenToken> {
    this.tokenCalls += 1;
    if (this.tokenFails) return Promise.reject(this.tokenFails);
    return Promise.resolve({
      token: `docgen-from-${ctx.accessToken}`,
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });
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

  it("answers a late caller with the rotation that consumed its secret", async () => {
    let clock = 0;
    const coordinator = new RefreshCoordinator({ now: () => clock, graceMs: 10_000 });
    let runs = 0;
    const refresh = async () => {
      runs += 1;
      return sessionExpiring(15, String(runs + 1));
    };

    const first = await coordinator.run("refresh-1", refresh);
    // Another tab's request, sent with the old cookie, arrives afterwards.
    clock += 400;
    const late = await coordinator.run("refresh-1", refresh);
    assert.equal(runs, 1, "the consumed secret was presented again");
    assert.equal(late, first);

    // Past the grace period the secret is exchanged again, and the API decides.
    clock += 10_000;
    await coordinator.run("refresh-1", refresh);
    assert.equal(runs, 2);
  });

  it("does not remember a rotation that failed", async () => {
    const coordinator = new RefreshCoordinator();
    let runs = 0;
    const failing = async (): Promise<Session> => {
      runs += 1;
      throw new Error("refused");
    };
    await assert.rejects(coordinator.run("refresh-1", failing));
    await assert.rejects(coordinator.run("refresh-1", failing));
    assert.equal(runs, 2);
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

describe("DocgenTokenCache", () => {
  it("mints once while the token is still good", async () => {
    const cache = new DocgenTokenCache(clock);
    let minted = 0;
    const mint = async () => {
      minted += 1;
      return { token: `t-${minted}`, expiresAt: new Date(now.getTime() + 300_000) };
    };

    assert.equal(await cache.token("office-a", mint), "t-1");
    assert.equal(await cache.token("office-a", mint), "t-1");
    assert.equal(minted, 1);

    // Another office is another token: the office decides what the document
    // service shows.
    assert.equal(await cache.token("office-b", mint), "t-2");
  });

  it("mints again near expiry, and after being forgotten", async () => {
    const cache = new DocgenTokenCache(clock);
    let minted = 0;
    const expiring = async () => {
      minted += 1;
      // Within the skew, so it counts as spent the moment it is held.
      return { token: `t-${minted}`, expiresAt: new Date(now.getTime() + 10_000) };
    };

    await cache.token("office-a", expiring);
    await cache.token("office-a", expiring);
    assert.equal(minted, 2);

    cache.forget("office-a");
    await cache.token("office-a", expiring);
    assert.equal(minted, 3);
  });
});

describe("SessionManager", () => {
  let auth: FakeIdentity;
  let store: FakeStore;
  let manager: SessionManager;

  function build(session: Session | null) {
    auth = new FakeIdentity();
    store = new FakeStore(session);
    manager = new SessionManager({
      identity: auth,
      store,
      coordinator: new RefreshCoordinator(),
      tokens: new DocgenTokenCache(clock),
      clock,
    });
  }

  beforeEach(() => build(sessionExpiring(15)));

  /**
   * The document service never sees the platform's own access token: what
   * reaches it is a short token minted for this session.
   */
  it("passes a minted document-service token to the call", async () => {
    const seen: (string | undefined)[] = [];

    await manager.authorize({}, async (ctx) => {
      seen.push(ctx.accessToken);
      return "done";
    });

    assert.deepEqual(seen, ["docgen-from-access-1"]);
    assert.equal(auth.tokenCalls, 1);
    assert.equal(auth.refreshCalls, 0);
  });

  it("reuses the minted token across calls", async () => {
    await manager.authorize({}, async () => "one");
    await manager.authorize({}, async () => "two");

    assert.equal(auth.tokenCalls, 1);
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
    assert.equal(token, "docgen-from-access-2");
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
    assert.deepEqual(tokens, ["docgen-from-access-2", "docgen-from-access-2"]);
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
    assert.equal(token, "docgen-from-access-2");
    // A minted token is worthless once the session behind it is gone, so the
    // refusal drops it rather than handing the same one over again.
    assert.equal(auth.tokenCalls, 2);
  });

  it("clears the session when the platform refuses to mint a token", async () => {
    auth.tokenFails = new AuthenticationError();

    await assert.rejects(
      manager.authorize({}, async () => "unreachable"),
      AuthenticationError,
    );
    assert.equal(store.session, null);
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

  it("signs out at the platform and locally", async () => {
    await manager.signOut({});

    assert.equal(auth.logoutCalls, 1);
    assert.equal(store.session, null);
  });

  // Whatever the API says, the user asked to be signed out, so the local
  // session must not survive the attempt.
  it("clears the session even when signing out at the platform fails", async () => {
    auth.logout = () => Promise.reject(new UnexpectedError("network down"));

    await assert.rejects(manager.signOut({}), UnexpectedError);
    assert.equal(store.session, null);
  });
});
