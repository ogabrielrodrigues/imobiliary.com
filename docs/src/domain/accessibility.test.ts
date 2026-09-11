import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appearanceAttributes,
  DEFAULT_PREFERENCES,
  parsePreferences,
  resolveAppearance,
  type SystemPreferences,
} from "./accessibility.ts";

const QUIET_SYSTEM: SystemPreferences = {
  prefersLight: false,
  prefersMoreContrast: false,
  prefersReducedMotion: false,
};

describe("parsePreferences", () => {
  it("reads a valid record as it is", () => {
    const stored = { theme: "paper", fontScale: 1.25, contrast: "more", motion: "reduce" };
    assert.deepEqual(parsePreferences(stored), stored);
  });

  it("falls back to the default for anything that is not a record", () => {
    for (const value of [null, undefined, "large", 42, []]) {
      assert.deepEqual(parsePreferences(value), DEFAULT_PREFERENCES);
    }
  });

  it("drops a bad field without losing the good ones", () => {
    assert.deepEqual(
      parsePreferences({ theme: "neon", fontScale: 9, contrast: "more", motion: "spin" }),
      { theme: "dark", fontScale: 1, contrast: "more", motion: "system" },
    );
  });

  it("reads a record from before themes existed as the dark theme", () => {
    assert.equal(parsePreferences({ fontScale: 1.5 }).theme, "dark");
  });

  it("does not accept a scale written as a string", () => {
    // A hand-edited "1.5" is not 1.5; accepting it would put a value on the
    // page that no stylesheet rule matches.
    assert.equal(parsePreferences({ fontScale: "1.5" }).fontScale, 1);
  });
});

describe("resolveAppearance", () => {
  it("keeps a chosen theme whatever the system prefers", () => {
    for (const theme of ["dark", "light", "paper"] as const) {
      const resolved = resolveAppearance(
        { ...DEFAULT_PREFERENCES, theme },
        { ...QUIET_SYSTEM, prefersLight: true },
      );
      assert.equal(resolved.scheme, theme);
    }
  });

  it("follows the system between dark and light, never paper", () => {
    const system = { ...DEFAULT_PREFERENCES, theme: "system" } as const;
    assert.equal(resolveAppearance(system, QUIET_SYSTEM).scheme, "dark");
    assert.equal(
      resolveAppearance(system, { ...QUIET_SYSTEM, prefersLight: true }).scheme,
      "light",
    );
  });

  it("lets a chosen contrast override the system in either direction", () => {
    const loud = { ...QUIET_SYSTEM, prefersMoreContrast: true };
    assert.equal(resolveAppearance(DEFAULT_PREFERENCES, loud).contrast, "more");
    assert.equal(resolveAppearance(DEFAULT_PREFERENCES, QUIET_SYSTEM).contrast, "standard");
    assert.equal(
      resolveAppearance({ ...DEFAULT_PREFERENCES, contrast: "standard" }, loud).contrast,
      "standard",
    );
    assert.equal(
      resolveAppearance({ ...DEFAULT_PREFERENCES, contrast: "more" }, QUIET_SYSTEM).contrast,
      "more",
    );
  });

  it("reduces motion when either the reader or the system asks", () => {
    assert.equal(resolveAppearance(DEFAULT_PREFERENCES, QUIET_SYSTEM).motion, "no-preference");
    assert.equal(
      resolveAppearance(DEFAULT_PREFERENCES, { ...QUIET_SYSTEM, prefersReducedMotion: true }).motion,
      "reduce",
    );
    assert.equal(
      resolveAppearance({ ...DEFAULT_PREFERENCES, motion: "reduce" }, QUIET_SYSTEM).motion,
      "reduce",
    );
  });
});

describe("appearanceAttributes", () => {
  it("names the attributes the stylesheet keys on", () => {
    assert.deepEqual(
      appearanceAttributes({ scheme: "paper", contrast: "standard", motion: "reduce", fontScale: 1.125 }),
      {
        "data-scheme": "paper",
        "data-contrast": "standard",
        "data-motion": "reduce",
        "data-font-scale": "1.125",
      },
    );
  });
});
