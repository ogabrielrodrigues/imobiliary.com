import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listPositions, NO_FORMAT, type Block, type ListKind } from "./block.ts";

const item = (kind: ListKind, level: number): Block => ({
  type: "paragraph",
  segments: [],
  format: { ...NO_FORMAT, list: { kind, level } },
});
const paragraph: Block = { type: "paragraph", segments: [] };

describe("list positions", () => {
  it("numbers levels on their own and resets deeper counts", () => {
    const markers = listPositions([
      item("ordered", 0),
      item("ordered", 1),
      item("ordered", 1),
      item("ordered", 2),
      item("ordered", 0),
      item("ordered", 1),
    ]).map((p) => p?.marker);
    assert.deepEqual(markers, ["1.", "a)", "b)", "i.", "2.", "a)"]);
  });

  it("starts a new list after anything that is not a list item", () => {
    const positions = listPositions([item("ordered", 0), item("ordered", 0), paragraph, item("ordered", 0)]);
    assert.deepEqual(
      positions.map((p) => p && [p.instance, p.marker]),
      [[0, "1."], [0, "2."], null, [1, "1."]],
    );
  });

  it("starts a new list when the top level changes kind", () => {
    const positions = listPositions([item("bullet", 0), item("ordered", 0)]);
    assert.deepEqual(positions.map((p) => p?.instance), [0, 1]);
  });

  it("keeps one kind per level inside a list, as a .docx numbering does", () => {
    const positions = listPositions([item("bullet", 0), item("ordered", 1), item("bullet", 0), item("bullet", 1)]);
    // Word restarts a level after an item above it, so the second "a)" is right.
    assert.deepEqual(positions.map((p) => p?.marker), ["•", "a)", "•", "a)"]);
  });

  it("draws bullets by level", () => {
    assert.deepEqual(
      listPositions([item("bullet", 0), item("bullet", 1), item("bullet", 2), item("bullet", 3)]).map((p) => p?.marker),
      ["•", "◦", "▪", "•"],
    );
  });

  it("ignores a list set on a heading", () => {
    const heading: Block = { type: "heading1", segments: [], format: { ...NO_FORMAT, list: { kind: "bullet", level: 0 } } };
    assert.deepEqual(listPositions([heading]), [null]);
  });
});
