import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectPages } from "./paging.ts";
import type { Page } from "./ports.ts";

/** A fake listing of `total` numbered items, recording each request. */
function listing(total: number) {
  const requests: Page[] = [];
  const fetchPage = async (page: Page) => {
    requests.push(page);
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 20;
    return Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => offset + i);
  };
  return { requests, fetchPage };
}

describe("collectPages", () => {
  it("stops at the first short page", async () => {
    const { requests, fetchPage } = listing(250);
    const result = await collectPages(fetchPage, { pageSize: 100 });
    assert.equal(result.items.length, 250);
    assert.equal(result.truncated, false);
    assert.deepEqual(requests, [
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
      { limit: 100, offset: 200 },
    ]);
  });

  it("asks once more after an exactly full page, and finds the end", async () => {
    const { requests, fetchPage } = listing(200);
    const result = await collectPages(fetchPage, { pageSize: 100 });
    assert.equal(result.items.length, 200);
    assert.equal(result.truncated, false);
    assert.equal(requests.length, 3);
  });

  it("keeps items in order", async () => {
    const { fetchPage } = listing(130);
    const result = await collectPages(fetchPage, { pageSize: 50 });
    assert.deepEqual(result.items, Array.from({ length: 130 }, (_, i) => i));
  });

  it("stops at the cap and says the listing may be incomplete", async () => {
    const { requests, fetchPage } = listing(5000);
    const result = await collectPages(fetchPage, { pageSize: 100, cap: 250 });
    assert.equal(result.items.length, 250);
    assert.equal(result.truncated, true);
    // The last request asks only for what the cap still allows.
    assert.deepEqual(requests.at(-1), { limit: 50, offset: 200 });
  });

  it("handles an empty listing with one request", async () => {
    const { requests, fetchPage } = listing(0);
    const result = await collectPages(fetchPage);
    assert.deepEqual(result, { items: [], truncated: false });
    assert.equal(requests.length, 1);
  });
});
