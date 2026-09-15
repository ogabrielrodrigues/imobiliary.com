/**
 * Reads a .docx into the block tree the interface renders.
 *
 * This is a **preview**, not a source of truth. Values fill placeholders, but
 * the document is still rendered by the API from the original archive, so
 * nothing here can affect the file a user ends up with. That is what allows a
 * deliberately simple reading of what `domain/block.ts` models: paragraphs,
 * heading level, alignment, indentation, line spacing, lists, page breaks,
 * emphasis, font size and the position of each placeholder. No fonts, colours,
 * images or tables.
 *
 * It must never be used to rewrite a Word template — round-tripping through
 * this model would discard everything it does not model.
 */

import {
  LINE_SPACINGS,
  MAX_INDENT,
  MAX_LIST_LEVEL,
  NO_FORMAT,
  NO_MARKS,
  type Alignment,
  type Block,
  type BlockFormat,
  type BlockType,
  type LineSpacing,
  type ListKind,
  type Marks,
  type Segment,
} from "../../domain/block.ts";
import { readZipEntry } from "./zip.ts";

export const MAIN_DOCUMENT_PART = "word/document.xml";
export const NUMBERING_PART = "word/numbering.xml";

/** For each numbering instance id, the kind of list at each level. */
export type Numbering = ReadonlyMap<string, readonly ListKind[]>;


/** Pulls the block tree out of a whole archive. */
export function parseDocx(archive: Uint8Array): Block[] {
  const part = readZipEntry(archive, MAIN_DOCUMENT_PART);
  if (part === null) {
    throw new Error(`archive is missing ${MAIN_DOCUMENT_PART}`);
  }
  const numbering = readZipEntry(archive, NUMBERING_PART);
  return parseDocumentXml(
    new TextDecoder().decode(part),
    numbering === null ? new Map() : parseNumberingXml(new TextDecoder().decode(numbering)),
  );
}

/**
 * Which instances are bulleted and which numbered, level by level. A level
 * whose format is "bullet" is a bulleted list; any other format (decimal,
 * letters, roman) reads as numbered.
 */
export function parseNumberingXml(xml: string): Numbering {
  const abstract = new Map<string, ListKind[]>();
  const instances = new Map<string, string>();

  let abstractId: string | null = null;
  let level = -1;
  let numId: string | null = null;

  for (const token of tokenize(xml)) {
    if (token.kind === "text") continue;
    const name = localName(token.name);

    if (token.kind === "close") {
      if (name === "abstractNum") abstractId = null;
      if (name === "num") numId = null;
      continue;
    }

    switch (name) {
      case "abstractNum":
        abstractId = token.attributes["w:abstractNumId"] ?? null;
        if (abstractId !== null) abstract.set(abstractId, []);
        break;
      case "lvl":
        level = Number(token.attributes["w:ilvl"] ?? -1);
        break;
      case "numFmt":
        if (abstractId !== null && level >= 0 && level <= MAX_LIST_LEVEL) {
          abstract.get(abstractId)![level] = token.attributes["w:val"] === "bullet" ? "bullet" : "ordered";
        }
        break;
      case "num":
        numId = token.attributes["w:numId"] ?? null;
        break;
      case "abstractNumId":
        if (numId !== null && token.attributes["w:val"] !== undefined) {
          instances.set(numId, token.attributes["w:val"]);
        }
        break;
    }
  }

  const numbering = new Map<string, readonly ListKind[]>();
  for (const [id, abstractRef] of instances) {
    numbering.set(id, abstract.get(abstractRef) ?? []);
  }
  return numbering;
}

/**
 * Parses a WordprocessingML part.
 *
 * Nested paragraphs — a text box holds one inside a run — are flattened into
 * the surrounding sequence. For a reading preview that is the right shape;
 * anything more faithful would be modelling layout, which this deliberately
 * does not do.
 */
export function parseDocumentXml(xml: string, numbering: Numbering = new Map()): Block[] {
  const blocks: Block[] = [];

  let block: MutableBlock | null = null;
  let marks: Marks = NO_MARKS;
  let inRunProperties = false;
  let inParagraphProperties = false;
  let inText = false;

  // A page break ends the paragraph it sits in; the text after it continues
  // in a paragraph of the same kind, which is dropped if it stays empty.
  const breakPage = () => {
    if (block === null) return;
    const continued = { ...emptyBlock(block.type), properties: block.properties, continuation: true };
    if (block.segments.length > 0) blocks.push(finish(block, numbering));
    blocks.push({ type: "pageBreak", segments: [] });
    block = continued;
  };

  for (const token of tokenize(xml)) {
    if (token.kind === "text") {
      if (inText && block) pushText(block, token.value, marks);
      continue;
    }

    const name = localName(token.name);

    if (token.kind === "open" || token.kind === "self") {
      switch (name) {
        case "p":
          // A nested paragraph ends the one around it rather than corrupting
          // it; both become blocks in reading order.
          if (block) blocks.push(finish(block, numbering));
          block = emptyBlock("paragraph");
          break;
        case "pPr":
          inParagraphProperties = true;
          break;
        case "pStyle":
          if (inParagraphProperties && block) {
            block.type = headingLevel(token.attributes["w:val"] ?? "");
          }
          break;
        case "jc":
          if (inParagraphProperties && !inRunProperties && block) {
            block.properties.align = alignment(token.attributes["w:val"] ?? "");
          }
          break;
        case "spacing":
          if (inParagraphProperties && !inRunProperties && block) {
            const spacing = lineSpacing(token.attributes);
            if (spacing !== undefined) block.properties.lineSpacing = spacing;
          }
          break;
        case "ind":
          if (inParagraphProperties && !inRunProperties && block) {
            const left = Number(token.attributes["w:left"] ?? token.attributes["w:start"] ?? 0);
            const firstLine = Number(token.attributes["w:firstLine"] ?? 0);
            block.properties.indent = Math.min(MAX_INDENT, Math.max(0, Math.round(left / 709)));
            block.properties.firstLineIndent = firstLine > 0;
          }
          break;
        case "ilvl":
          if (inParagraphProperties && block) {
            block.properties.level = Number(token.attributes["w:val"] ?? 0);
          }
          break;
        case "numId":
          if (inParagraphProperties && block) {
            block.properties.numId = token.attributes["w:val"] ?? null;
          }
          break;
        case "rPr":
          inRunProperties = true;
          marks = NO_MARKS;
          break;
        case "b":
          if (inRunProperties && isOn(token.attributes)) {
            marks = { ...marks, bold: true };
          }
          break;
        case "i":
          if (inRunProperties && isOn(token.attributes)) {
            marks = { ...marks, italic: true };
          }
          break;
        case "u":
          // <w:u w:val="none"/> is an explicit removal, not an application.
          if (inRunProperties && (token.attributes["w:val"] ?? "single") !== "none") {
            marks = { ...marks, underline: true };
          }
          break;
        case "strike":
          if (inRunProperties && isOn(token.attributes)) {
            marks = { ...marks, strike: true };
          }
          break;
        case "sz": {
          const halfPoints = Number(token.attributes["w:val"]);
          if (inRunProperties && Number.isFinite(halfPoints) && halfPoints > 0) {
            marks = { ...marks, size: halfPoints / 2 };
          }
          break;
        }
        case "vertAlign": {
          const value = token.attributes["w:val"];
          if (inRunProperties) {
            marks = { ...marks, superscript: value === "superscript", subscript: value === "subscript" };
          }
          break;
        }
        case "r":
          marks = NO_MARKS;
          break;
        case "t":
          inText = token.kind === "open";
          break;
        case "br":
          if (token.attributes["w:type"] === "page") breakPage();
          else if (block) pushText(block, "\n", marks);
          break;
        case "tab":
          // Inside w:pPr a tab is a tab stop definition, not a character.
          if (block && !inParagraphProperties) pushText(block, "\t", marks);
          break;
      }
    }

    if (token.kind === "close") {
      switch (name) {
        case "p":
          if (block) {
            if (!(block.continuation && block.segments.length === 0)) {
              blocks.push(finish(block, numbering));
            }
            block = null;
          }
          break;
        case "pPr":
          inParagraphProperties = false;
          break;
        case "rPr":
          inRunProperties = false;
          break;
        case "t":
          inText = false;
          break;
      }
    }
  }

  if (block) blocks.push(finish(block, numbering));
  return blocks;
}


// ----- building --------------------------------------------------------

interface ParagraphProperties {
  align: Alignment | null;
  lineSpacing: LineSpacing | null;
  indent: number;
  firstLineIndent: boolean;
  numId: string | null;
  level: number;
}

interface MutableBlock {
  type: BlockType;
  segments: Segment[];
  properties: ParagraphProperties;
  /** Opened after a page break inside another paragraph. */
  continuation: boolean;
}

function emptyBlock(type: BlockType): MutableBlock {
  return {
    type,
    segments: [],
    properties: { align: null, lineSpacing: null, indent: 0, firstLineIndent: false, numId: null, level: 0 },
    continuation: false,
  };
}

function finish(block: MutableBlock, numbering: Numbering): Block {
  const { numId, level: rawLevel, ...rest } = block.properties;
  const level = Math.min(MAX_LIST_LEVEL, Math.max(0, rawLevel));
  // numId 0 is Word's explicit "no list".
  const list =
    numId !== null && numId !== "0" && block.type === "paragraph"
      ? { kind: numbering.get(numId)?.[level] ?? ("bullet" as ListKind), level }
      : null;

  const format: BlockFormat = { ...rest, list, indent: list === null ? rest.indent : 0 };
  const unset =
    format.align === NO_FORMAT.align &&
    format.lineSpacing === NO_FORMAT.lineSpacing &&
    format.indent === 0 &&
    !format.firstLineIndent &&
    format.list === null;
  return unset ? { type: block.type, segments: block.segments } : { type: block.type, segments: block.segments, format };
}

function alignment(value: string): Alignment | null {
  switch (value) {
    case "left":
    case "start":
      return "left";
    case "center":
      return "center";
    case "right":
    case "end":
      return "right";
    case "both":
    case "distribute":
      return "justify";
    default:
      return null;
  }
}

/**
 * The line spacing Word calls "multiple", snapped to the values the model
 * offers; exact or at-least spacing, and anything between steps, is left unset.
 */
function lineSpacing(attributes: Record<string, string>): LineSpacing | null | undefined {
  const line = attributes["w:line"];
  if (line === undefined) return undefined;
  const rule = attributes["w:lineRule"] ?? "auto";
  if (rule !== "auto") return null;
  const factor = Number(line) / 240;
  return LINE_SPACINGS.find((step) => Math.abs(step - factor) < 0.02) ?? null;
}

function headingLevel(style: string): BlockType {
  switch (style.toLowerCase().replace(/[\s-]/g, "")) {
    case "heading1":
    case "ttulo1":
    case "título1":
      return "heading1";
    case "heading2":
    case "ttulo2":
    case "título2":
      return "heading2";
    case "heading3":
    case "ttulo3":
    case "título3":
      return "heading3";
    default:
      return "paragraph";
  }
}

/** `<w:b/>` means on; `<w:b w:val="0"/>` means off. */
function isOn(attributes: Record<string, string>): boolean {
  const value = attributes["w:val"];
  return value === undefined || !["0", "false", "off"].includes(value);
}

const PLACEHOLDER = /\{\{\s*\.([a-z][a-z0-9_]*)\s*\}\}/g;

/**
 * Adds text to a block, splitting out any placeholders it contains.
 *
 * The stored template has already been normalised by the API, so a placeholder
 * always sits whole inside one run and never straddles this boundary.
 */
function pushText(block: MutableBlock, raw: string, marks: Marks): void {
  const text = raw;
  let cursor = 0;

  PLACEHOLDER.lastIndex = 0;
  for (
    let match = PLACEHOLDER.exec(text);
    match !== null;
    match = PLACEHOLDER.exec(text)
  ) {
    if (match.index > cursor) {
      block.segments.push({
        kind: "text",
        text: text.slice(cursor, match.index),
        ...marks,
      });
    }
    block.segments.push({ kind: "placeholder", name: match[1]!, ...marks });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    block.segments.push({ kind: "text", text: text.slice(cursor), ...marks });
  }
}

// ----- tokenizing ------------------------------------------------------

type Token =
  | { kind: "open" | "close" | "self"; name: string; attributes: Record<string, string> }
  | { kind: "text"; value: string };

/**
 * Walks the XML.
 *
 * A focused scanner rather than a general parser: the input is machine-written
 * OOXML, so this only has to survive what Word emits — tags, attributes,
 * entities and CDATA-free text.
 */
function* tokenize(xml: string): Generator<Token> {
  let at = 0;

  while (at < xml.length) {
    const open = xml.indexOf("<", at);

    if (open === -1) {
      const trailing = xml.slice(at);
      if (trailing !== "") yield { kind: "text", value: decodeEntities(trailing) };
      return;
    }

    if (open > at) {
      yield { kind: "text", value: decodeEntities(xml.slice(at, open)) };
    }

    // Declarations, comments and processing instructions carry nothing needed.
    if (xml.startsWith("<!--", open)) {
      at = advancePast(xml, open, "-->");
      continue;
    }
    if (xml.startsWith("<?", open) || xml.startsWith("<!", open)) {
      at = advancePast(xml, open, ">");
      continue;
    }

    const close = xml.indexOf(">", open);
    if (close === -1) return;

    const body = xml.slice(open + 1, close);
    at = close + 1;

    if (body.startsWith("/")) {
      yield { kind: "close", name: body.slice(1).trim(), attributes: {} };
      continue;
    }

    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const space = inner.search(/\s/);

    const name = space === -1 ? inner : inner.slice(0, space);
    const attributes =
      space === -1 ? {} : parseAttributes(inner.slice(space + 1));

    yield { kind: selfClosing ? "self" : "open", name: name.trim(), attributes };
  }
}

function advancePast(xml: string, from: number, terminator: string): number {
  const end = xml.indexOf(terminator, from);
  return end === -1 ? xml.length : end + terminator.length;
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  ATTRIBUTE.lastIndex = 0;
  for (
    let match = ATTRIBUTE.exec(source);
    match !== null;
    match = ATTRIBUTE.exec(source)
  ) {
    attributes[match[1]!] = decodeEntities(match[2]!);
  }
  return attributes;
}

/** Strips the namespace prefix: `w:pStyle` becomes `pStyle`. */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;

  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}
