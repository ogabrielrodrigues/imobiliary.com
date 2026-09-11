import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { busiestDay, isStatsPeriod, periodChange } from "./stats.ts";

describe("isStatsPeriod", () => {
  it("accepts only the windows the API offers", () => {
    for (const days of [7, 30, 90]) assert.ok(isStatsPeriod(days));
    for (const days of [0, 15, 365, "30", null]) assert.ok(!isStatsPeriod(days));
  });
});

describe("periodChange", () => {
  it("reports growth and decline as rounded percentages", () => {
    assert.equal(periodChange(12, 9), 33);
    assert.equal(periodChange(3, 6), -50);
    assert.equal(periodChange(5, 5), 0);
  });

  it("has no answer when the previous window was empty", () => {
    assert.equal(periodChange(4, 0), null);
    assert.equal(periodChange(0, 0), null);
  });
});

describe("busiestDay", () => {
  it("picks the day with the most documents, the earliest on a tie", () => {
    const day = busiestDay([
      { date: "2026-09-09", documents: 1 },
      { date: "2026-09-10", documents: 4 },
      { date: "2026-09-11", documents: 4 },
    ]);
    assert.equal(day?.date, "2026-09-10");
  });

  it("has nothing to say about a window without documents", () => {
    assert.equal(busiestDay([{ date: "2026-09-11", documents: 0 }]), null);
    assert.equal(busiestDay([]), null);
  });
});
