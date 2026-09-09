import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { placeholdersOf } from "../../domain/block.ts";
import { parseDocumentXml, parseDocx } from "./parse.ts";
import { readZipEntry, writeZip, ZipError } from "./zip.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function document(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body>
</w:document>`;
}

const run = (text: string, properties = "") =>
  `<w:r>${properties}<w:t xml:space="preserve">${text}</w:t></w:r>`;

describe("zip", () => {
  it("round-trips entries through the central directory", () => {
    const archive = writeZip([
      { name: "word/document.xml", data: encode("<w:document/>") },
      { name: "[Content_Types].xml", data: encode("<Types/>") },
    ]);

    assert.equal(decode(readZipEntry(archive, "word/document.xml")!), "<w:document/>");
    assert.equal(decode(readZipEntry(archive, "[Content_Types].xml")!), "<Types/>");
  });

  it("returns null for an entry that is not there", () => {
    const archive = writeZip([{ name: "a.xml", data: encode("<a/>") }]);
    assert.equal(readZipEntry(archive, "missing.xml"), null);
  });

  it("survives content large enough to actually compress", () => {
    // Small payloads can deflate to more than they started as; this checks the
    // ordinary path where compression does something.
    const big = "<w:t>" + "conteúdo repetido ".repeat(2000) + "</w:t>";
    const archive = writeZip([{ name: "big.xml", data: encode(big) }]);

    assert.ok(archive.byteLength < encode(big).byteLength, "nothing was compressed");
    assert.equal(decode(readZipEntry(archive, "big.xml")!), big);
  });

  it("keeps non-ASCII entry names and content intact", () => {
    const archive = writeZip([
      { name: "word/documento-ação.xml", data: encode("Ribeirão Preto — ação") },
    ]);

    assert.equal(
      decode(readZipEntry(archive, "word/documento-ação.xml")!),
      "Ribeirão Preto — ação",
    );
  });

  it("refuses something that is not an archive", () => {
    assert.throws(() => readZipEntry(encode("not a zip at all"), "a"), ZipError);
  });

  it("reads a whole document out of an archive", () => {
    const archive = writeZip([
      {
        name: "word/document.xml",
        data: encode(document(`<w:p>${run("Olá {{.nome}}")}</w:p>`)),
      },
    ]);

    const blocks = parseDocx(archive);
    assert.deepEqual(placeholdersOf(blocks), ["nome"]);
  });
});

describe("parsing a document", () => {
  it("splits placeholders out of the text around them", () => {
    const [block] = parseDocumentXml(
      document(`<w:p>${run("Locatário: {{.locatario_nome}}, CPF {{.cpf}}")}</w:p>`),
    );

    assert.deepEqual(
      block?.segments.map((s) =>
        s.kind === "placeholder" ? `<${s.name}>` : s.text,
      ),
      ["Locatário: ", "<locatario_nome>", ", CPF ", "<cpf>"],
    );
  });

  it("reads heading levels from the paragraph style", () => {
    const blocks = parseDocumentXml(
      document(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run("Título")}</w:p>` +
          `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr>${run("Menor")}</w:p>` +
          `<w:p>${run("Corpo")}</w:p>`,
      ),
    );

    assert.deepEqual(
      blocks.map((b) => b.type),
      ["heading1", "heading3", "paragraph"],
    );
  });

  it("carries bold, italic and underline onto the segments", () => {
    const [block] = parseDocumentXml(
      document(
        `<w:p>${run("forte", "<w:rPr><w:b/></w:rPr>")}${run("normal")}${run(
          "sublinhado",
          "<w:rPr><w:u w:val=\"single\"/></w:rPr>",
        )}</w:p>`,
      ),
    );

    assert.deepEqual(
      block?.segments.map((s) => ({
        bold: s.bold,
        italic: s.italic,
        underline: s.underline,
      })),
      [
        { bold: true, italic: false, underline: false },
        { bold: false, italic: false, underline: false },
        { bold: false, italic: false, underline: true },
      ],
    );
  });

  // <w:b w:val="0"/> switches bold off; treating any <w:b> as "on" would
  // embolden text Word shows as plain.
  it("honours a property that is explicitly turned off", () => {
    const [block] = parseDocumentXml(
      document(`<w:p>${run("plano", '<w:rPr><w:b w:val="0"/><w:u w:val="none"/></w:rPr>')}</w:p>`),
    );

    assert.equal(block?.segments[0]?.bold, false);
    assert.equal(block?.segments[0]?.underline, false);
  });

  it("decodes the entities the writer escaped", () => {
    const [block] = parseDocumentXml(
      document(`<w:p>${run("Acme &amp; Filhos &lt;Ltda&gt; &#233;")}</w:p>`),
    );

    const segment = block?.segments[0];
    assert.equal(
      segment?.kind === "text" ? segment.text : null,
      "Acme & Filhos <Ltda> é",
    );
  });

  it("turns a line break into a newline", () => {
    const [block] = parseDocumentXml(
      document(`<w:p><w:r><w:t>uma</w:t><w:br/><w:t>outra</w:t></w:r></w:p>`),
    );

    const text = block?.segments
      .map((s) => (s.kind === "text" ? s.text : ""))
      .join("");
    assert.equal(text, "uma\noutra");
  });

  // A text box puts a whole paragraph inside a run. Flattening keeps reading
  // order without pretending to model layout.
  it("flattens a paragraph nested inside another", () => {
    const blocks = parseDocumentXml(
      document(
        `<w:p>${run("fora")}<w:r><w:txbxContent><w:p>${run("dentro")}</w:p></w:txbxContent></w:r></w:p>`,
      ),
    );

    assert.equal(blocks.length, 2);
    assert.deepEqual(
      blocks.map((b) =>
        b.segments.map((s) => (s.kind === "text" ? s.text : "")).join(""),
      ),
      ["fora", "dentro"],
    );
  });

  it("ignores the declaration and any comments", () => {
    const blocks = parseDocumentXml(
      document(`<!-- uma nota --><w:p>${run("visível")}</w:p>`),
    );

    assert.equal(blocks.length, 1);
  });

  it("collects each placeholder once, in the order they appear", () => {
    const blocks = parseDocumentXml(
      document(
        `<w:p>${run("{{.b}} e {{.a}}")}</w:p><w:p>${run("{{.a}} de novo")}</w:p>`,
      ),
    );

    assert.deepEqual(placeholdersOf(blocks), ["b", "a"]);
  });

  it("handles a document with nothing in it", () => {
    assert.deepEqual(parseDocumentXml(document("")), []);
  });
});
