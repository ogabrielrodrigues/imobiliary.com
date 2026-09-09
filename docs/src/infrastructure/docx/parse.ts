/**
 * Reads a .docx into the block tree the interface renders.
 *
 * This is a **preview**, not a source of truth. Values fill placeholders, but
 * the document is still rendered by the API from the original archive, so
 * nothing here can affect the file a user ends up with. That is what allows a
 * deliberately simple reading: paragraphs, heading level, bold/italic/underline
 * and the position of each placeholder. No page breaks, no fonts, no images,
 * no tables.
 *
 * It must never be used to rewrite a Word template — round-tripping through
 * this model would discard everything it does not model.
 */

import {
  NO_MARKS,
  type Block,
  type BlockType,
  type Marks,
  type Segment,
} from "../../domain/block.ts";
import { readZipEntry } from "./zip.ts";

export const MAIN_DOCUMENT_PART = "word/document.xml";


/** Pulls the block tree out of a whole archive. */
export function parseDocx(archive: Uint8Array): Block[] {
  const part = readZipEntry(archive, MAIN_DOCUMENT_PART);
  if (part === null) {
    throw new Error(`archive is missing ${MAIN_DOCUMENT_PART}`);
  }
  return parseDocumentXml(new TextDecoder().decode(part));
}

/**
 * Parses a WordprocessingML part.
 *
 * Nested paragraphs — a text box holds one inside a run — are flattened into
 * the surrounding sequence. For a reading preview that is the right shape;
 * anything more faithful would be modelling layout, which this deliberately
 * does not do.
 */
export function parseDocumentXml(xml: string): Block[] {
  const blocks: Block[] = [];

  let block: MutableBlock | null = null;
  let marks: Marks = NO_MARKS;
  let inRunProperties = false;
  let inParagraphProperties = false;
  let inText = false;

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
          if (block) blocks.push(finish(block));
          block = { type: "paragraph", segments: [] };
          break;
        case "pPr":
          inParagraphProperties = true;
          break;
        case "pStyle":
          if (inParagraphProperties && block) {
            block.type = headingLevel(token.attributes["w:val"] ?? "");
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
        case "r":
          marks = NO_MARKS;
          break;
        case "t":
          inText = token.kind === "open";
          break;
        case "br":
        case "tab":
          if (block) pushText(block, name === "tab" ? "\t" : "\n", marks);
          break;
      }
    }

    if (token.kind === "close") {
      switch (name) {
        case "p":
          if (block) {
            blocks.push(finish(block));
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

  if (block) blocks.push(finish(block));
  return blocks;
}


// ----- building --------------------------------------------------------

interface MutableBlock {
  type: BlockType;
  segments: Segment[];
}

function finish(block: MutableBlock): Block {
  return { type: block.type, segments: block.segments };
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
