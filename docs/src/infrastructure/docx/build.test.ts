import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_MARKS, type Block } from "../../domain/block.ts";
import { normalizeBlocks, parseBlockSource } from "../../domain/block-source.ts";
import { buildDocumentXml, buildDocx, SOURCE_PART } from "./build.ts";
import { MAIN_DOCUMENT_PART, parseDocumentXml, parseDocx } from "./parse.ts";
import { readZipEntry } from "./zip.ts";

const text = (value: string, marks: Partial<typeof NO_MARKS> = {}) =>
  ({ kind: "text", text: value, ...NO_MARKS, ...marks }) as const;
const field = (name: string, marks: Partial<typeof NO_MARKS> = {}) =>
  ({ kind: "placeholder", name, ...NO_MARKS, ...marks }) as const;

const CONTRACT: Block[] = [
  { type: "heading1", segments: [text("Contrato de locação")] },
  { type: "heading2", segments: [text("1. Das partes")] },
  {
    type: "paragraph",
    segments: [
      text("Locador: "),
      field("locador_nome", { bold: true }),
      text(", inscrito no CPF "),
      field("locador_cpf"),
      text("."),
    ],
  },
  { type: "paragraph", segments: [] },
  { type: "heading3", segments: [text("Observações", { italic: true, underline: true })] },
  { type: "paragraph", segments: [text("Primeira linha\nsegunda linha\tcom tab")] },
  { type: "paragraph", segments: [text("Acme & Filhos <Ltda> \"aspas\"")] },
];

describe("building a document", () => {
  it("reads back through the parser as the same tree", () => {
    // The parser splits text at breaks and tabs; the normal form joins it again.
    assert.deepEqual(normalizeBlocks(parseDocumentXml(buildDocumentXml(CONTRACT))), CONTRACT);
  });

  it("writes a whole archive the parser reads", () => {
    const archive = buildDocx(CONTRACT, { title: "Contrato" });
    assert.deepEqual(normalizeBlocks(parseDocx(archive)), CONTRACT);
  });

  it("stores the tree inside the archive", () => {
    const archive = buildDocx(CONTRACT);
    const source = readZipEntry(archive, SOURCE_PART);
    assert.ok(source !== null);
    assert.deepEqual(parseBlockSource(new TextDecoder().decode(source)), CONTRACT);
  });

  it("carries every part Word needs, with a type for each", () => {
    const archive = buildDocx(CONTRACT);
    const types = new TextDecoder().decode(readZipEntry(archive, "[Content_Types].xml")!);

    for (const name of [
      "_rels/.rels",
      MAIN_DOCUMENT_PART,
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "word/settings.xml",
      "docProps/core.xml",
      "docProps/app.xml",
    ]) {
      assert.ok(readZipEntry(archive, name) !== null, `missing ${name}`);
    }
    assert.match(types, /Extension="json"/);
  });

  it("escapes text and keeps its spaces", () => {
    const xml = buildDocumentXml([{ type: "paragraph", segments: [text(" a & <b> ")] }]);
    assert.match(xml, /<w:t xml:space="preserve"> a &amp; &lt;b&gt; <\/w:t>/);
  });

  it("writes a placeholder whole inside one run, with its marks", () => {
    const xml = buildDocumentXml([{ type: "paragraph", segments: [field("valor", { bold: true })] }]);
    assert.match(xml, /<w:r><w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">\{\{\.valor\}\}<\/w:t><\/w:r>/);
  });

  it("drops characters XML cannot carry instead of writing a broken file", () => {
    const archive = buildDocx([{ type: "paragraph", segments: [text("ab")] }]);
    assert.deepEqual(parseDocx(archive), [{ type: "paragraph", segments: [text("ab")] }]);
  });

  it("puts only a title in the properties, never an author", () => {
    const archive = buildDocx(CONTRACT, { title: "Contrato & aditivo" });
    const core = new TextDecoder().decode(readZipEntry(archive, "docProps/core.xml")!);
    assert.match(core, /<dc:title>Contrato &amp; aditivo<\/dc:title>/);
    assert.doesNotMatch(core, /creator|lastModifiedBy/);
  });
});
