import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import {
  appearanceAttributes,
  parsePreferences,
  resolveAppearance,
  type SystemPreferences,
} from "../domain/accessibility.ts";
import {
  bootScript,
  SCHEME_BACKGROUNDS,
  STORAGE_KEY,
  SYSTEM_QUERIES,
} from "./accessibility-storage.ts";

const QUIET: SystemPreferences = {
  prefersLight: false,
  prefersMoreContrast: false,
  prefersReducedMotion: false,
};

/**
 * Runs the inline script the way a browser would, against a stored value and
 * a system, and returns what it left on <html> and in the theme-color meta.
 */
function runBoot(
  stored: string | null,
  system: SystemPreferences = QUIET,
  storageThrows = false,
): { attributes: Record<string, string>; themeColor: string | undefined } {
  const attributes: Record<string, string> = {};
  let themeColor: string | undefined;
  const asked: Record<string, boolean> = {
    [SYSTEM_QUERIES.prefersLight]: system.prefersLight,
    [SYSTEM_QUERIES.prefersMoreContrast]: system.prefersMoreContrast,
    [SYSTEM_QUERIES.prefersReducedMotion]: system.prefersReducedMotion,
  };
  runInNewContext(bootScript(), {
    JSON,
    String,
    localStorage: {
      getItem(key: string) {
        if (storageThrows) throw new Error("SecurityError");
        return key === STORAGE_KEY ? stored : null;
      },
    },
    window: { matchMedia: (query: string) => ({ matches: asked[query] ?? false }) },
    document: {
      documentElement: {
        setAttribute(name: string, value: string) {
          attributes[name] = value;
        },
      },
      querySelector: () => ({
        setAttribute(_name: string, value: string) {
          themeColor = value;
        },
      }),
    },
  });
  return { attributes, themeColor };
}

/** What the settings screen would put on the page for the same inputs. */
function expected(stored: unknown, system: SystemPreferences) {
  return appearanceAttributes(resolveAppearance(parsePreferences(stored), system));
}

const SYSTEMS: readonly SystemPreferences[] = [
  QUIET,
  { prefersLight: true, prefersMoreContrast: false, prefersReducedMotion: false },
  { prefersLight: false, prefersMoreContrast: true, prefersReducedMotion: true },
  { prefersLight: true, prefersMoreContrast: true, prefersReducedMotion: true },
];

const RECORDS: readonly unknown[] = [
  { theme: "paper", fontScale: 1.5, contrast: "more", motion: "reduce" },
  { theme: "system", fontScale: 1, contrast: "system", motion: "system" },
  { theme: "light", contrast: "standard" },
  { theme: "neon", fontScale: "1.5", contrast: "more", motion: 3 },
  [],
];

describe("the boot script", () => {
  it("resolves exactly as the settings screen would, for every system", () => {
    for (const system of SYSTEMS) {
      for (const record of RECORDS) {
        assert.deepEqual(
          runBoot(JSON.stringify(record), system).attributes,
          expected(record, system),
          `record ${JSON.stringify(record)}, system ${JSON.stringify(system)}`,
        );
      }
    }
  });

  it("still resolves the system on a first visit, with nothing stored", () => {
    for (const stored of [null, "not json", "42", "null"]) {
      assert.deepEqual(runBoot(stored, SYSTEMS[3]).attributes, expected(null, SYSTEMS[3]!));
    }
  });

  it("survives storage that throws", () => {
    assert.deepEqual(runBoot(null, QUIET, true).attributes, expected(null, QUIET));
  });

  it("gives the browser chrome the background of the theme on the page", () => {
    assert.equal(runBoot(JSON.stringify({ theme: "paper" })).themeColor, SCHEME_BACKGROUNDS.paper);
    assert.equal(
      runBoot(JSON.stringify({ theme: "system" }), SYSTEMS[1]).themeColor,
      SCHEME_BACKGROUNDS.light,
    );
    assert.equal(runBoot(null).themeColor, SCHEME_BACKGROUNDS.dark);
  });
});
