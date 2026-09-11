import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { parsePreferences, preferenceAttributes } from "../domain/accessibility.ts";
import { bootScript, STORAGE_KEY } from "./accessibility-storage.ts";

/**
 * Runs the inline script the way a browser would, against a stored value, and
 * returns the attributes it left on <html>.
 */
function runBoot(stored: string | null, storageThrows = false): Record<string, string> {
  const attributes: Record<string, string> = {};
  runInNewContext(bootScript(), {
    JSON,
    String,
    localStorage: {
      getItem(key: string) {
        if (storageThrows) throw new Error("SecurityError");
        return key === STORAGE_KEY ? stored : null;
      },
    },
    document: {
      documentElement: {
        setAttribute(name: string, value: string) {
          attributes[name] = value;
        },
      },
    },
  });
  return attributes;
}

describe("the boot script", () => {
  it("applies a stored preference exactly as the settings screen would", () => {
    const stored = { fontScale: 1.5, contrast: "more", motion: "reduce" };
    assert.deepEqual(
      runBoot(JSON.stringify(stored)),
      preferenceAttributes(parsePreferences(stored)),
    );
  });

  it("applies only the fields that are valid", () => {
    assert.deepEqual(
      runBoot(JSON.stringify({ fontScale: "1.5", contrast: "more", motion: 3 })),
      { "data-contrast": "more" },
    );
  });

  it("leaves the page alone when there is nothing usable", () => {
    for (const stored of [null, "not json", "42", "null"]) {
      assert.deepEqual(runBoot(stored), {});
    }
  });

  it("survives storage that throws", () => {
    assert.deepEqual(runBoot(null, true), {});
  });
});
