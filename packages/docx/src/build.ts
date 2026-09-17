/**
 * Writes a .docx from the block tree: the mirror of `parse.ts`.
 *
 * Only for templates authored in the block editor. It writes exactly what the
 * tree models (see `domain/block.ts`) and nothing else, so it must never be
 * pointed at a tree read out of a Word document: that would discard all the
 * formatting the reader does not model.
 *
 * The package is the smallest one Word opens without complaint: the main
 * document, its styles, numbering and settings, the core and app properties,
 * the relationships and content types. Inside it rides
 * `imobiliary/source.json`, the tree itself, so the template can be opened in
 * the editor again.
 *
 * Element order inside `w:pPr`, `w:rPr` and the numbering follows the schema.
 * Word is strict about it: an element out of order is "unreadable content".
 */

import {
  formatOf,
  listPositions,
  type Alignment,
  type Block,
  type ListKind,
  type ListPosition,
  type Marks,
  type Segment,
} from "./block.ts";
import { normalizeBlocks, serializeBlockSource } from "./block-source.ts";
import { writeZip, type ZipEntry } from "./zip.ts";
import { MAIN_DOCUMENT_PART } from "./parse.ts";

/** Where the editor's copy of the tree lives inside the archive. */
export const SOURCE_PART = "imobiliary/source.json";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The style id Word knows each heading by; `parse.ts` reads the same ids. */
const HEADING_STYLE: Record<Exclude<Block["type"], "paragraph" | "pageBreak">, string> = {
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
    part("word/numbering.xml", buildNumberingXml(tree)),
    part("word/settings.xml", SETTINGS),
    part(SOURCE_PART, serializeBlockSource(tree)),
  ]);
}

/** The main document part alone. */
export function buildDocumentXml(blocks: readonly Block[]): string {
  const positions = listPositions(blocks);
  const body = blocks.map((block, index) => paragraph(block, positions[index] ?? null)).join("");
  return (
    XML_DECLARATION +
    `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}${SECTION}</w:body></w:document>`
  );
}

/** Twentieths of a point in 1.25 cm, one indentation step. */
const INDENT_STEP = 709;

const JUSTIFICATION: Record<Alignment, string> = {
  left: "left",
  center: "center",
  right: "right",
  justify: "both",
};

function paragraph(block: Block, list: ListPosition | null): string {
  if (block.type === "pageBreak") return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

  const format = formatOf(block);
  const properties =
    (block.type === "paragraph" ? "" : `<w:pStyle w:val="${HEADING_STYLE[block.type]}"/>`) +
    (list === null ? "" : `<w:numPr><w:ilvl w:val="${list.level}"/><w:numId w:val="${list.instance + 1}"/></w:numPr>`) +
    (format.lineSpacing === null
      ? ""
      : `<w:spacing w:line="${Math.round(format.lineSpacing * 240)}" w:lineRule="auto"/>`) +
    indentation(format.indent, format.firstLineIndent) +
    (format.align === null ? "" : `<w:jc w:val="${JUSTIFICATION[format.align]}"/>`);

  const runs = block.segments.map(run).join("");
  return `<w:p>${properties === "" ? "" : `<w:pPr>${properties}</w:pPr>`}${runs}</w:p>`;
}

function indentation(steps: number, firstLine: boolean): string {
  if (steps === 0 && !firstLine) return "";
  return (
    "<w:ind" +
    (steps > 0 ? ` w:left="${steps * INDENT_STEP}"` : "") +
    (firstLine ? ` w:firstLine="${INDENT_STEP}"` : "") +
    "/>"
  );
}

/**
 * One run per segment. A placeholder is written whole inside its own run,
 * which is the shape the API's normalisation would produce anyway.
 */
function run(segment: Segment): string {
  const text = segment.kind === "text" ? segment.text : `{{.${segment.name}}}`;
  return `<w:r>${runProperties(segment)}${runContent(text)}</w:r>`;
}

/** In schema order: b, i, strike, sz, u, vertAlign. Sizes are in half points. */
function runProperties(marks: Marks): string {
  const size = marks.size === null ? "" : String(Math.round(marks.size * 2));
  const inner =
    (marks.bold ? "<w:b/><w:bCs/>" : "") +
    (marks.italic ? "<w:i/><w:iCs/>" : "") +
    (marks.strike ? "<w:strike/>" : "") +
    (size === "" ? "" : `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`) +
    (marks.underline ? '<w:u w:val="single"/>' : "") +
    (marks.superscript
      ? '<w:vertAlign w:val="superscript"/>'
      : marks.subscript
        ? '<w:vertAlign w:val="subscript"/>'
        : "");
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

// ----- numbering -------------------------------------------------------

/**
 * One abstract numbering and one instance per list, so every list restarts at
 * 1 and each level keeps the kind `listPositions` settled on. Always written,
 * empty when there are no lists, so the package never changes shape.
 */
export function buildNumberingXml(blocks: readonly Block[]): string {
  const kinds = new Map<number, ListKind[]>();
  for (const position of listPositions(blocks)) {
    if (position === null) continue;
    const levels = kinds.get(position.instance) ?? [];
    levels[position.level] ??= position.kind;
    kinds.set(position.instance, levels);
  }

  const instances = [...kinds.entries()].sort(([a], [b]) => a - b);
  const abstract = instances
    .map(([instance, levels]) => {
      const fallback = levels.find((kind) => kind !== undefined) ?? "bullet";
      const lvls = Array.from({ length: 9 }, (_, level) => listLevel(level, levels[level] ?? fallback)).join("");
      return `<w:abstractNum w:abstractNumId="${instance}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`;
    })
    .join("");
  const nums = instances
    .map(([instance]) => `<w:num w:numId="${instance + 1}"><w:abstractNumId w:val="${instance}"/></w:num>`)
    .join("");

  return XML_DECLARATION + `<w:numbering xmlns:w="${W}">${abstract}${nums}</w:numbering>`;
}

const BULLET_TEXT = ["•", "◦", "▪"] as const;
const ORDERED_FORMAT = [
  ["decimal", "."],
  ["lowerLetter", ")"],
  ["lowerRoman", "."],
] as const;

/** One level: its marker, then a hanging indent that grows with depth. */
function listLevel(level: number, kind: ListKind): string {
  const [format, text] =
    kind === "bullet"
      ? ["bullet", BULLET_TEXT[level % BULLET_TEXT.length]!]
      : [ORDERED_FORMAT[level % 3]![0], `%${level + 1}${ORDERED_FORMAT[level % 3]![1]}`];
  return (
    `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/>` +
    `<w:lvlText w:val="${escapeXml(text)}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
  );
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
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
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
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
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
  `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
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
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  heading(1, 32, 360) +
  heading(2, 26, 240) +
  heading(3, 24, 200) +
  "</w:styles>";
