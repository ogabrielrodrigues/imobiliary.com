import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_FORMAT, NO_MARKS, type Block, type BlockFormat } from "../../domain/block.ts";
import { normalizeBlocks, parseBlockSource } from "../../domain/block-source.ts";
import { buildDocumentXml, buildDocx, buildNumberingXml, SOURCE_PART } from "./build.ts";
import { MAIN_DOCUMENT_PART, parseDocumentXml, parseDocx, parseNumberingXml } from "./parse.ts";
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

  it("always writes the numbering part, even without lists", () => {
    const archive = buildDocx([{ type: "paragraph", segments: [text("ok")] }]);
    assert.ok(readZipEntry(archive, "word/numbering.xml") !== null);
  });
});

const formatted = (format: Partial<BlockFormat>, ...segments: Block["segments"]): Block => ({
  type: "paragraph",
  segments,
  format: { ...NO_FORMAT, ...format },
});

const RICH: Block[] = [
  { type: "heading1", segments: [text("Título")], format: { ...NO_FORMAT, align: "center" } },
  formatted({ align: "justify", lineSpacing: 1.5 }, text("justificado")),
  formatted({ indent: 2, firstLineIndent: true, align: "right" }, text("recuado")),
  formatted({ lineSpacing: 2 }, text("m"), text("2", { superscript: true }), text(" H"), text("2", { subscript: true }), text("O")),
  { type: "paragraph", segments: [text("grande", { size: 18 }), text(" riscado", { strike: true, size: 10.5 })] },
  formatted({ list: { kind: "ordered", level: 0 } }, text("um")),
  formatted({ list: { kind: "ordered", level: 1 } }, text("um.a")),
  formatted({ list: { kind: "ordered", level: 0 } }, text("dois"), field("campo", { bold: true })),
  { type: "pageBreak", segments: [] },
  formatted({ list: { kind: "bullet", level: 0 } }, text("marcador")),
  formatted({ list: { kind: "bullet", level: 1 }, align: "center" }, text("sub")),
  { type: "paragraph", segments: [text("fim")] },
];

describe("building formatted documents", () => {
  it("reads alignment, spacing, indentation, lists, breaks and marks back as written", () => {
    assert.deepEqual(normalizeBlocks(parseDocx(buildDocx(RICH))), RICH);
  });

  it("writes paragraph properties in the order the schema requires", () => {
    const xml = buildDocumentXml([
      {
        type: "heading2",
        segments: [text("x")],
        format: { ...NO_FORMAT, align: "justify", lineSpacing: 1.15, indent: 1, firstLineIndent: true },
      },
    ]);
    assert.match(
      xml,
      /<w:pPr><w:pStyle w:val="Heading2"\/><w:spacing w:line="276" w:lineRule="auto"\/><w:ind w:left="709" w:firstLine="709"\/><w:jc w:val="both"\/><\/w:pPr>/,
    );
  });

  it("writes run properties in the order the schema requires", () => {
    const xml = buildDocumentXml([
      { type: "paragraph", segments: [text("x", { bold: true, italic: true, strike: true, size: 12, underline: true, superscript: true })] },
    ]);
    assert.match(
      xml,
      /<w:rPr><w:b\/><w:bCs\/><w:i\/><w:iCs\/><w:strike\/><w:sz w:val="24"\/><w:szCs w:val="24"\/><w:u w:val="single"\/><w:vertAlign w:val="superscript"\/><\/w:rPr>/,
    );
  });

  it("gives every list its own numbering so each restarts", () => {
    const blocks = [
      formatted({ list: { kind: "ordered", level: 0 } }, text("a")),
      { type: "paragraph", segments: [text("entre")] } satisfies Block,
      formatted({ list: { kind: "ordered", level: 0 } }, text("b")),
    ];
    const numbering = buildNumberingXml(blocks);
    assert.equal(numbering.match(/<w:abstractNum /g)?.length, 2);
    assert.equal(numbering.match(/<w:num /g)?.length, 2);
    // Every abstract numbering comes before the first instance, as the schema requires.
    assert.ok(numbering.lastIndexOf("<w:abstractNum ") < numbering.indexOf("<w:num "));
    assert.deepEqual([...parseNumberingXml(numbering).keys()], ["1", "2"]);
  });

  it("writes a page break as its own paragraph", () => {
    assert.match(buildDocumentXml([{ type: "pageBreak", segments: [] }]), /<w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p>/);
  });
});
