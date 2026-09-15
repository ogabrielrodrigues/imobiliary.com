/**
 * Writes a .docx from the block tree: the mirror of `parse.ts`.
 *
 * Only for templates authored in the block editor. It writes exactly what the
 * tree models — headings, paragraphs, bold, italic, underline, line breaks,
 * tabs and placeholders — and nothing else, so it must never be pointed at a
 * tree read out of a Word document: that would discard all the formatting the
 * reader does not model.
 *
 * The package is the smallest one Word opens without complaint: the main
 * document, its styles and settings, the core and app properties, the
 * relationships and content types. Inside it rides `imobiliary/source.json`,
 * the tree itself, so the template can be opened in the editor again.
 */

import type { Block, Marks, Segment } from "../../domain/block.ts";
import { normalizeBlocks, serializeBlockSource } from "../../domain/block-source.ts";
import { writeZip, type ZipEntry } from "./zip.ts";
import { MAIN_DOCUMENT_PART } from "./parse.ts";

/** Where the editor's copy of the tree lives inside the archive. */
export const SOURCE_PART = "imobiliary/source.json";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The style id Word knows each heading by; `parse.ts` reads the same ids. */
const HEADING_STYLE: Record<Exclude<Block["type"], "paragraph">, string> = {
  heading1: "Heading1",
  heading2: "Heading2",
  heading3: "Heading3",
};

export interface BuildOptions {
  /** The document title in its properties, usually the template name. */
  readonly title?: string;
}

/** A complete .docx for a tree, with the tree stored inside it. */
export function buildDocx(blocks: readonly Block[], options: BuildOptions = {}): Uint8Array {
  const tree = normalizeBlocks(blocks);
  const encoder = new TextEncoder();
  const part = (name: string, text: string): ZipEntry => ({ name, data: encoder.encode(text) });

  return writeZip([
    part("[Content_Types].xml", CONTENT_TYPES),
    part("_rels/.rels", PACKAGE_RELATIONSHIPS),
    part("docProps/core.xml", coreProperties(options.title ?? "")),
    part("docProps/app.xml", APP_PROPERTIES),
    part(MAIN_DOCUMENT_PART, buildDocumentXml(tree)),
    part("word/_rels/document.xml.rels", DOCUMENT_RELATIONSHIPS),
    part("word/styles.xml", STYLES),
    part("word/settings.xml", SETTINGS),
    part(SOURCE_PART, serializeBlockSource(tree)),
  ]);
}

/** The main document part alone. */
export function buildDocumentXml(blocks: readonly Block[]): string {
  const body = blocks.map(paragraph).join("");
  return (
    XML_DECLARATION +
    `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}${SECTION}</w:body></w:document>`
  );
}

function paragraph(block: Block): string {
  const properties =
    block.type === "paragraph"
      ? ""
      : `<w:pPr><w:pStyle w:val="${HEADING_STYLE[block.type]}"/></w:pPr>`;
  const runs = block.segments.map(run).join("");
  return `<w:p>${properties}${runs}</w:p>`;
}

/**
 * One run per segment. A placeholder is written whole inside its own run,
 * which is the shape the API's normalisation would produce anyway.
 */
function run(segment: Segment): string {
  const text = segment.kind === "text" ? segment.text : `{{.${segment.name}}}`;
  return `<w:r>${runProperties(segment)}${runContent(text)}</w:r>`;
}

/** Element order follows the schema: b, i, then u. Word is strict about it. */
function runProperties(marks: Marks): string {
  const inner =
    (marks.bold ? "<w:b/><w:bCs/>" : "") +
    (marks.italic ? "<w:i/><w:iCs/>" : "") +
    (marks.underline ? '<w:u w:val="single"/>' : "");
  return inner === "" ? "" : `<w:rPr>${inner}</w:rPr>`;
}

/**
 * Text, with line breaks and tabs as the elements Word uses for them.
 * Every `<w:t>` preserves its spaces: without it Word drops leading and
 * trailing whitespace, and "Nome: " followed by a field loses its space.
 */
function runContent(text: string): string {
  const out: string[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer !== "") out.push(`<w:t xml:space="preserve">${escapeXml(buffer)}</w:t>`);
    buffer = "";
  };

  for (const character of text) {
    if (character === "\n") {
      flush();
      out.push("<w:br/>");
    } else if (character === "\t") {
      flush();
      out.push("<w:tab/>");
    } else {
      buffer += character;
    }
  }
  flush();
  return out.join("");
}

export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ----- the fixed parts -------------------------------------------------

/** A4, with the margins Brazilian documents commonly use (3 cm left and top, 2 cm right and bottom). */
const SECTION =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1701" w:right="1134" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/>' +
  "</w:sectPr>";

const CONTENT_TYPES =
  XML_DECLARATION +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  // Every part in a package needs a type, including one Word does not read.
  '<Default Extension="json" ContentType="application/json"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  "</Types>";

const PACKAGE_RELATIONSHIPS =
  XML_DECLARATION +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  "</Relationships>";

const DOCUMENT_RELATIONSHIPS =
  XML_DECLARATION +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
  "</Relationships>";

/**
 * Only a title: no author and no dates. Who wrote a template is not something
 * the file needs to carry into every document generated from it.
 */
function coreProperties(title: string): string {
  return (
    XML_DECLARATION +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    "</cp:coreProperties>"
  );
}

const APP_PROPERTIES =
  XML_DECLARATION +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  "<Application>Imobiliary Docs</Application>" +
  "</Properties>";

/** Compatibility mode 15 keeps Word from opening the file in its legacy mode. */
const SETTINGS =
  XML_DECLARATION +
  `<w:settings xmlns:w="${W}">` +
  '<w:defaultTabStop w:val="709"/>' +
  '<w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  "</w:settings>";

/**
 * Normal and three headings. The names are Word's built-in ones ("heading 1"),
 * which Word shows in the reader's language, "Título 1" in Portuguese, and
 * which keep the headings in its navigation pane.
 */
const heading = (level: 1 | 2 | 3, size: number, before: number) =>
  `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
  `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>` +
  '<w:uiPriority w:val="9"/><w:qFormat/>' +
  `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="120"/><w:jc w:val="left"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
  `<w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
  "</w:style>";

const STYLES =
  XML_DECLARATION +
  `<w:styles xmlns:w="${W}">` +
  "<w:docDefaults>" +
  '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="pt-BR" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  "</w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:jc w:val="both"/></w:pPr></w:style>' +
  heading(1, 32, 360) +
  heading(2, 26, 240) +
  heading(3, 24, 200) +
  "</w:styles>";
