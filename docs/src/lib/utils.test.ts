import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { cn, FONT_SIZES } from "./utils.ts";

const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

describe("cn and the type scale", () => {
  it("knows every size the stylesheet declares", () => {
    const declared = [...css.matchAll(/--text-([a-z0-9-]+):/g)].map((m) => m[1]);
    assert.deepEqual([...declared].sort(), [...FONT_SIZES].sort());
  });

  it("keeps a size next to a text colour", () => {
    for (const size of FONT_SIZES) {
      assert.equal(cn(`text-${size} text-foreground`), `text-${size} text-foreground`);
    }
  });

  it("still lets a later size replace an earlier one", () => {
    assert.equal(cn("text-small text-caption"), "text-caption");
  });
});
