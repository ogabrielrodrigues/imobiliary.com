import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  preferenceAttributes,
} from "./accessibility.ts";

describe("parsePreferences", () => {
  it("reads a valid record as it is", () => {
    const stored = { fontScale: 1.25, contrast: "more", motion: "reduce" };
    assert.deepEqual(parsePreferences(stored), stored);
  });

  it("falls back to the default for anything that is not a record", () => {
    for (const value of [null, undefined, "large", 42, []]) {
      assert.deepEqual(parsePreferences(value), DEFAULT_PREFERENCES);
    }
  });

  it("drops a bad field without losing the good ones", () => {
    assert.deepEqual(
      parsePreferences({ fontScale: 9, contrast: "more", motion: "spin" }),
      { fontScale: 1, contrast: "more", motion: "system" },
    );
  });

  it("does not accept a scale written as a string", () => {
    // A hand-edited "1.5" is not 1.5; accepting it would put a value on the
    // page that no stylesheet rule matches.
    assert.equal(parsePreferences({ fontScale: "1.5" }).fontScale, 1);
  });
});

describe("preferenceAttributes", () => {
  it("names the attributes the stylesheet keys on", () => {
    assert.deepEqual(
      preferenceAttributes({ fontScale: 1.125, contrast: "standard", motion: "system" }),
      { "data-font-scale": "1.125", "data-contrast": "standard", "data-motion": "system" },
    );
  });
});
