import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createDocgenClient } from "./docgen-client.ts";

/**
 * These tests exist because of a real regression.
 *
 * When the API began requiring a recorded terms acceptance, this gateway kept
 * sending the old three-field body. Registration failed with a 422 naming a
 * field the form does not show, and nothing caught it: the type carried
 * `termsVersion`, so the typechecker was satisfied, and the layers above stop
 * at `application/`.
 *
 * The gap was the wire format — what this file actually asserts. A gateway is
 * a translation, and a translation is only correct if someone reads both sides.
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

const account = {
  id: "01a0871a-f3c4-7a14-af5e-ffb1353c4790",
  email: "alguem@example.com",
  name: "Alguém",
  created_at: "2026-09-10T12:00:00Z",
};

describe("the registration request", () => {
  it("carries the accepted terms version", async () => {
    const { fetch, calls } = recordingFetch(account);
    const client = createDocgenClient({ baseUrl: "http://api.test", fetch });

    await client.auth.register(
      {},
      {
        email: "alguem@example.com",
        name: "Alguém",
        password: "uma-senha-suficientemente-longa",
        termsVersion: "1.0",
      },
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://api.test/v1/auth/register");
    assert.equal(calls[0]?.method, "POST");
    // The whole body, not just the new field: the API rejects a request that
    // is missing any of them, and asserting the shape is what keeps the two
    // sides describing the same thing.
    assert.deepEqual(calls[0]?.body, {
      email: "alguem@example.com",
      name: "Alguém",
      password: "uma-senha-suficientemente-longa",
      terms_version: "1.0",
    });
  });

  it("names the fields the way the API does", async () => {
    const { fetch, calls } = recordingFetch(account);
    const client = createDocgenClient({ baseUrl: "http://api.test", fetch });

    await client.auth.register(
      {},
      {
        email: "outro@example.com",
        name: "Outro",
        password: "uma-senha-suficientemente-longa",
        termsVersion: "2.0",
      },
    );

    const sent = calls[0]?.body as Record<string, unknown>;
    // snake_case on the wire, camelCase in the domain. A camelCase key here
    // would be silently ignored by the API rather than reported.
    assert.ok("terms_version" in sent, "expected terms_version on the wire");
    assert.ok(!("termsVersion" in sent), "camelCase leaked to the wire");
  });
});
