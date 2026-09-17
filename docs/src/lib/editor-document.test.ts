import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_FORMAT, NO_MARKS, type Block, type BlockFormat, type Marks } from "@imobiliary/docx/blocks";
import { blocksToEditor, editorToBlocks, pointsOf, type EditorNode } from "./editor-document.ts";

const text = (value: string, marks: Partial<Marks> = {}) =>
  ({ kind: "text", text: value, ...NO_MARKS, ...marks }) as const;
const field = (name: string, marks: Partial<Marks> = {}) =>
  ({ kind: "placeholder", name, ...NO_MARKS, ...marks }) as const;
const item = (value: string, kind: "bullet" | "ordered", level: number, format: Partial<BlockFormat> = {}): Block => ({
  type: "paragraph",
  segments: [text(value)],
  format: { ...NO_FORMAT, ...format, list: { kind, level } },
});

const TREE: Block[] = [
  { type: "heading1", segments: [text("Contrato")], format: { ...NO_FORMAT, align: "center" } },
  { type: "heading3", segments: [text("Partes", { italic: true })] },
  {
    type: "paragraph",
    segments: [
      text("Locador: "),
      field("locador_nome", { bold: true, size: 12 }),
      text("\nlinha dois", { underline: true, strike: true }),
      text("o", { superscript: true }),
      text("2", { subscript: true }),
    ],
    format: { ...NO_FORMAT, align: "justify", lineSpacing: 1.5, indent: 2, firstLineIndent: true },
  },
  item("primeiro", "ordered", 0),
  item("a", "bullet", 1),
  item("b", "bullet", 1, { align: "right" }),
  item("segundo", "ordered", 0),
  { type: "pageBreak", segments: [] },
  item("outra lista", "bullet", 0),
  { type: "paragraph", segments: [] },
];

describe("the editor document", () => {
  it("round-trips a block tree without loss", () => {
    assert.deepEqual(editorToBlocks(blocksToEditor(TREE) as EditorNode), TREE);
  });

  it("nests list items the way the editor holds them", () => {
    const doc = blocksToEditor(TREE);
    const ordered = doc.content?.[3];
    assert.equal(ordered?.type, "orderedList");
    assert.equal(ordered?.content?.length, 2);
    const firstItem = ordered?.content?.[0];
    assert.equal(firstItem?.content?.[0]?.type, "paragraph");
    assert.equal(firstItem?.content?.[1]?.type, "bulletList");
    assert.equal(firstItem?.content?.[1]?.content?.length, 2);
    assert.equal(doc.content?.[4]?.type, "pageBreak");
    assert.equal(doc.content?.[5]?.type, "bulletList");
  });

  it("writes paragraph settings as attributes and a size as a text style", () => {
    const doc = blocksToEditor(TREE);
    assert.deepEqual(doc.content?.[0]?.attrs, { textAlign: "center", level: 1 });
    assert.deepEqual(doc.content?.[2]?.attrs, { textAlign: "justify", lineSpacing: 1.5, indent: 2, firstLineIndent: true });
    assert.deepEqual(doc.content?.[2]?.content?.[1], {
      type: "field",
      attrs: { name: "locador_nome" },
      marks: [{ type: "bold" }, { type: "textStyle", attrs: { fontSize: "12pt" } }],
    });
  });

  it("gives an empty tree one paragraph to type in", () => {
    assert.deepEqual(blocksToEditor([]), { type: "doc", content: [{ type: "paragraph" }] });
  });

  it("fills a skipped list level instead of losing the item", () => {
    const blocks = [item("topo", "bullet", 0), item("fundo", "bullet", 2)];
    const back = editorToBlocks(blocksToEditor(blocks) as EditorNode);
    assert.deepEqual(
      back.map((b) => [b.segments.length > 0, b.format?.list?.level]),
      [[true, 0], [false, 1], [true, 2]],
    );
  });

  it("drops what the tree does not model instead of guessing", () => {
    const doc: EditorNode = {
      type: "doc",
      content: [
        { type: "table", content: [{ type: "paragraph", content: [{ type: "text", text: "célula" }] }] },
        { type: "heading", attrs: { level: 5 }, content: [{ type: "text", text: "nível 5" }] },
        {
          type: "paragraph",
          attrs: { textAlign: "diagonal", lineSpacing: 3, indent: 99 },
          content: [
            { type: "text", text: "a", marks: [{ type: "link" }, { type: "bold" }, { type: "textStyle", attrs: { fontSize: "2em" } }] },
            { type: "image" },
            { type: "field", attrs: { name: "" } },
          ],
        },
      ],
    };
    assert.deepEqual(editorToBlocks(doc), [
      { type: "paragraph", segments: [text("a", { bold: true })], format: { ...NO_FORMAT, indent: 8 } },
    ]);
  });

  it("reads only sizes in points that Word can hold", () => {
    assert.equal(pointsOf("12pt"), 12);
    assert.equal(pointsOf("10.5pt"), 10.5);
    assert.equal(pointsOf("16px"), null);
    assert.equal(pointsOf("200pt"), null);
    assert.equal(pointsOf("10.3pt"), null);
  });
});
