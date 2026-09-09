import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { relativeDate, shortDateTime } from "./format.ts";

const now = new Date("2026-09-09T14:00:00Z");

describe("relativeDate", () => {
  it("says 'agora mesmo' within the minute", () => {
    assert.equal(relativeDate(new Date(now.getTime() - 30_000), now), "agora mesmo");
  });

  it("counts minutes, hours and days", () => {
    const minutes = relativeDate(new Date(now.getTime() - 5 * 60_000), now);
    const hours = relativeDate(new Date(now.getTime() - 3 * 3_600_000), now);
    const days = relativeDate(new Date(now.getTime() - 2 * 86_400_000), now);

    assert.match(minutes, /minuto/);
    assert.match(hours, /hora/);
    assert.match(days, /dia|ontem|anteontem/);
  });

  it("falls back to a date beyond a month, where a relative count stops helping", () => {
    const old = relativeDate(new Date(now.getTime() - 90 * 86_400_000), now);
    assert.match(old, /^\d{2}\/\d{2}/);
  });
});

describe("shortDateTime", () => {
  // Regression: an earlier version appended a comma the locale had already
  // supplied, and the documents table showed "09/09,, 14:12".
  it("does not double the separator the locale already provides", () => {
    const rendered = shortDateTime(new Date("2026-09-09T14:12:00"));

    assert.ok(!rendered.includes(",,"), `got ${rendered}`);
    assert.match(rendered, /^\d{2}\/\d{2},? \d{2}:\d{2}$/);
  });
});
