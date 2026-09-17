import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDocgenClient } from "./docgen-client.ts";
import { createIdentityClient } from "./identity-client.ts";

/**
 * These tests exist because of a real regression.
 *
 * When the API began requiring a recorded terms acceptance, the registration
 * gateway kept sending the old three-field body. It failed with a 422 naming a
 * field the form does not show, and nothing caught it: the type carried
 * `termsVersion`, so the typechecker was satisfied, and the layers above stop
 * at `application/`.
 *
 * The gap was the wire format — what this file actually asserts. A gateway is
 * a translation, and a translation is only correct if someone reads both sides.
 * Registration has since moved to the Imobiliary platform; what is left to get
 * wrong is the sign-in body, the minted token, and who the document service
 * says the caller is.
 */

/** Records the request a gateway makes and answers with a canned body. */
function recordingFetch(body: unknown) {
  const calls: { url: string; method: string; body: unknown }[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body:
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : (init?.body ?? null),
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, calls };
}

const session = {
  user: {
    id: "01a0871a-f3c4-7a14-af5e-ffb1353c4790",
    email: "alguem@example.com",
    name: "Alguém",
    created_at: "2026-09-10T12:00:00Z",
    totp_enabled: true,
  },
  organization: { id: "01a0871a-f3c4-7a14-af5e-000000000001", name: "Central Imóveis" },
  role: "admin" as const,
  access_token: "access",
  access_expires_at: "2026-09-10T12:15:00Z",
  refresh_token: "refresh",
  refresh_expires_at: "2026-10-10T12:00:00Z",
  mfa_enrollment_required: false,
};

describe("signing in at the platform", () => {
  it("sends the credentials the way the platform names them", async () => {
    const { fetch, calls } = recordingFetch({
      mfa_required: false,
      session,
      organizations: [],
    });
    const identity = createIdentityClient({ baseUrl: "http://platform.test", fetch });

    const outcome = await identity.signIn({}, {
      email: "alguem@example.com",
      password: "uma-senha-suficientemente-longa",
    });

    assert.equal(calls[0]?.url, "http://platform.test/v1/sessions");
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[0]?.body, {
      email: "alguem@example.com",
      password: "uma-senha-suficientemente-longa",
    });
    assert.equal(outcome.kind, "session");
    if (outcome.kind === "session") {
      assert.equal(outcome.session.organization.name, "Central Imóveis");
      assert.equal(outcome.session.role, "admin");
    }
  });

  // A challenge arrives without a session, and the screen has to ask for a
  // code rather than treating the answer as a malformed session.
  it("reads a second factor as a challenge", async () => {
    const { fetch } = recordingFetch({
      mfa_required: true,
      challenge: "ch-1",
      organizations: [{ organization: { id: "o1", name: "Central" }, role: "member" }],
    });
    const identity = createIdentityClient({ baseUrl: "http://platform.test", fetch });

    const outcome = await identity.signIn({}, { email: "a@b.com", password: "x" });

    assert.equal(outcome.kind, "second_factor");
    if (outcome.kind === "second_factor") {
      assert.equal(outcome.challenge, "ch-1");
      assert.equal(outcome.organizations[0]?.organization.name, "Central");
    }
  });

  it("asks the platform for a token for the document service", async () => {
    const { fetch, calls } = recordingFetch({
      token: "minted",
      expires_at: "2026-09-10T12:05:00Z",
    });
    const identity = createIdentityClient({ baseUrl: "http://platform.test", fetch });

    const token = await identity.docgenToken({ accessToken: "access" });

    assert.equal(calls[0]?.url, "http://platform.test/v1/sessions/docgen-token");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(token.token, "minted");
    assert.deepEqual(token.expiresAt, new Date("2026-09-10T12:05:00Z"));
  });
});

describe("who the document service says the caller is", () => {
  it("reads the member, the office and the role", async () => {
    const { fetch, calls } = recordingFetch({
      user: {
        id: "01a0871a-f3c4-7a14-af5e-ffb1353c4790",
        email: "alguem@example.com",
        name: "Alguém",
        created_at: "2026-09-10T12:00:00Z",
      },
      office: {
        id: "01a0871a-f3c4-7a14-af5e-000000000001",
        name: "Central Imóveis",
        created_at: "2026-09-10T12:00:00Z",
      },
      role: "member",
    });
    const client = createDocgenClient({ baseUrl: "http://api.test", fetch });

    const caller = await client.office.current({ accessToken: "minted" });

    assert.equal(calls[0]?.url, "http://api.test/v1/me");
    assert.equal(caller.office.name, "Central Imóveis");
    assert.equal(caller.role, "member");
    assert.equal(caller.user.email, "alguem@example.com");
  });
});
