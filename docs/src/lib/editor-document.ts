/**
 * Converts between the block editor's document and the domain's block tree.
 *
 * The editor (TipTap, over ProseMirror) keeps its content as JSON nodes; the
 * platform stores and builds from `Block`. The two meet only here, in plain
 * data, so the conversion is testable without a browser or the editor library,
 * and nothing stored ever depends on the editor.
 *
 * Two shapes differ and are translated: the editor nests lists (a list holds
 * items, an item holds a paragraph and deeper lists), while a block tree, like
 * a .docx, keeps a flat run of paragraphs that each say their list and level.
 * Paragraph settings are node attributes on one side and `BlockFormat` on the
 * other; a font size is a `textStyle` mark holding "12pt" on one side and a
 * number of points on the other.
 *
 * The editor's schema allows exactly what a block models, so the conversion is
 * lossless in both directions. Anything else found in the JSON is dropped
 * rather than guessed at.
 */

import {
  formatOf,
  LINE_SPACINGS,
  MAX_INDENT,
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
} from "@imobiliary/docx/blocks";
import { isFontSize, normalizeBlocks } from "@imobiliary/docx/block-source";

/**
 * The subset of TipTap's `JSONContent` this schema produces, as read back.
 * Mutable and with explicit `undefined`, as `getJSON()` types it.
 */
export interface EditorNode {
  type?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  content?: EditorNode[] | undefined;
  marks?: { type: string; attrs?: Record<string, unknown> | undefined }[] | undefined;
  text?: string | undefined;
}

/**
 * What `blocksToEditor` writes: the same nodes, but with no property ever
 * present and undefined, which is the shape TipTap's `JSONContent` accepts.
 */
export interface WrittenNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: WrittenNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** The node and mark names of the editor's schema, shared with its extensions. */
export const EDITOR_NODES = {
  field: "field",
  hardBreak: "hardBreak",
  pageBreak: "pageBreak",
  bulletList: "bulletList",
  orderedList: "orderedList",
  listItem: "listItem",
  textStyle: "textStyle",
} as const;

const LIST_NODE: Record<ListKind, string> = {
  bullet: EDITOR_NODES.bulletList,
  ordered: EDITOR_NODES.orderedList,
};

const HEADING_LEVEL: Record<Exclude<BlockType, "paragraph" | "pageBreak">, 1 | 2 | 3> = {
  heading1: 1,
  heading2: 2,
  heading3: 3,
};

// ----- blocks → editor --------------------------------------------------

/** A block tree as the editor's document. */
export function blocksToEditor(blocks: readonly Block[]): WrittenNode {
  const content: WrittenNode[] = [];

  for (let index = 0; index < blocks.length; ) {
    if (listOf(blocks[index]) !== null) {
      const { node, next } = listNode(blocks, index, 0);
      content.push(node);
      index = next;
    } else {
      content.push(blockNode(blocks[index]!));
      index += 1;
    }
  }

  // ProseMirror needs at least one block to put the caret in.
  return { type: "doc", content: content.length === 0 ? [{ type: "paragraph" }] : content };
}

function listOf(block: Block | undefined) {
  return block !== undefined && block.type === "paragraph" ? formatOf(block).list : null;
}

/**
 * One list starting at `start`, holding every following item at `depth` or
 * deeper. Deeper items nest inside the item before them; an item deeper by
 * more than one level gets empty items in between, since the editor cannot
 * skip a level. A change of kind at the same depth starts a sibling list.
 */
function listNode(blocks: readonly Block[], start: number, depth: number): { node: WrittenNode; next: number } {
  const kind = listOf(blocks[start])!.kind;
  const items: WrittenNode[] = [];
  let index = start;

  while (index < blocks.length) {
    const list = listOf(blocks[index]);
    if (list === null || list.level < depth) break;

    if (list.level === depth) {
      if (list.kind !== kind && items.length > 0) break;
      items.push({ type: EDITOR_NODES.listItem, content: [blockNode(blocks[index]!)] });
      index += 1;
      continue;
    }

    if (items.length === 0) {
      items.push({ type: EDITOR_NODES.listItem, content: [{ type: "paragraph" }] });
    }
    const nested = listNode(blocks, index, depth + 1);
    items.at(-1)!.content!.push(nested.node);
    index = nested.next;
  }

  return { node: { type: LIST_NODE[kind], content: items }, next: index };
}

function blockNode(block: Block): WrittenNode {
  if (block.type === "pageBreak") return { type: EDITOR_NODES.pageBreak };

  const content = block.segments.flatMap(inlineNodes);
  const withContent = content.length === 0 ? {} : { content };
  const attrs = paragraphAttributes(formatOf(block));
  const withAttrs = Object.keys(attrs).length === 0 ? {} : { attrs };

  return block.type === "paragraph"
    ? { type: "paragraph", ...withAttrs, ...withContent }
    : { type: "heading", attrs: { ...attrs, level: HEADING_LEVEL[block.type] }, ...withContent };
}

/** Only the attributes that differ from their defaults, so plain paragraphs stay plain. */
function paragraphAttributes(format: BlockFormat): Record<string, unknown> {
  return {
    ...(format.align === null ? {} : { textAlign: format.align }),
    ...(format.lineSpacing === null ? {} : { lineSpacing: format.lineSpacing }),
    ...(format.indent === 0 ? {} : { indent: format.indent }),
    ...(format.firstLineIndent ? { firstLineIndent: true } : {}),
  };
}

function inlineNodes(segment: Segment): WrittenNode[] {
  const marks = markList(segment);
  const withMarks = marks.length === 0 ? {} : { marks };

  if (segment.kind === "placeholder") {
    return [{ type: EDITOR_NODES.field, attrs: { name: segment.name }, ...withMarks }];
  }

  // A line break is a node of its own in the editor, not a character.
  const nodes: WrittenNode[] = [];
  segment.text.split("\n").forEach((line, index) => {
    if (index > 0) nodes.push({ type: EDITOR_NODES.hardBreak, ...withMarks });
    if (line !== "") nodes.push({ type: "text", text: line, ...withMarks });
  });
  return nodes;
}

function markList(marks: Marks): { type: string; attrs?: Record<string, unknown> }[] {
  return [
    ...(marks.bold ? [{ type: "bold" }] : []),
    ...(marks.italic ? [{ type: "italic" }] : []),
    ...(marks.underline ? [{ type: "underline" }] : []),
    ...(marks.strike ? [{ type: "strike" }] : []),
    ...(marks.superscript ? [{ type: "superscript" }] : []),
    ...(marks.subscript ? [{ type: "subscript" }] : []),
    ...(marks.size === null ? [] : [{ type: EDITOR_NODES.textStyle, attrs: { fontSize: `${marks.size}pt` } }]),
  ];
}

// ----- editor → blocks --------------------------------------------------

/** The editor's document as a block tree, in its normal form. */
export function editorToBlocks(document: EditorNode): Block[] {
  const blocks: Block[] = [];
  for (const node of document.content ?? []) collect(node, null, blocks);
  return normalizeBlocks(blocks);
}

function collect(node: EditorNode, list: { kind: ListKind; level: number } | null, out: Block[]): void {
  switch (node.type) {
    case EDITOR_NODES.bulletList:
    case EDITOR_NODES.orderedList: {
      const kind: ListKind = node.type === EDITOR_NODES.bulletList ? "bullet" : "ordered";
      const level = list === null ? 0 : list.level + 1;
      for (const item of node.content ?? []) {
        if (item.type !== EDITOR_NODES.listItem) continue;
        for (const child of item.content ?? []) collect(child, { kind, level }, out);
      }
      return;
    }
    case EDITOR_NODES.pageBreak:
      if (list === null) out.push({ type: "pageBreak", segments: [] });
      return;
    case "paragraph":
    case "heading": {
      const type = blockType(node);
      if (type === null) return;
      const format: BlockFormat = {
        ...formatFrom(node.attrs),
        list: type === "paragraph" ? list : null,
      };
      out.push({ type, segments: (node.content ?? []).flatMap(segmentsOf), format });
      return;
    }
    default:
      return;
  }
}

function blockType(node: EditorNode): BlockType | null {
  if (node.type === "paragraph") return "paragraph";
  if (node.type !== "heading") return null;

  switch (node.attrs?.level) {
    case 1:
      return "heading1";
    case 2:
      return "heading2";
    case 3:
      return "heading3";
    default:
      return null;
  }
}

const ALIGNMENTS: readonly unknown[] = ["left", "center", "right", "justify"] satisfies Alignment[];

function formatFrom(attrs: Record<string, unknown> | undefined): Omit<BlockFormat, "list"> {
  const align = attrs?.textAlign;
  const spacing = attrs?.lineSpacing;
  const indent = attrs?.indent;
  return {
    align: ALIGNMENTS.includes(align) ? (align as Alignment) : NO_FORMAT.align,
    lineSpacing: (LINE_SPACINGS as readonly unknown[]).includes(spacing) ? (spacing as LineSpacing) : null,
    indent:
      typeof indent === "number" && Number.isInteger(indent) ? Math.min(Math.max(indent, 0), MAX_INDENT) : 0,
    firstLineIndent: attrs?.firstLineIndent === true,
  };
}

function segmentsOf(node: EditorNode): Segment[] {
  const marks = marksOf(node);

  switch (node.type) {
    case "text":
      return node.text ? [{ kind: "text", text: node.text, ...marks }] : [];
    case EDITOR_NODES.hardBreak:
      return [{ kind: "text", text: "\n", ...marks }];
    case EDITOR_NODES.field: {
      const name = node.attrs?.name;
      return typeof name === "string" && name !== "" ? [{ kind: "placeholder", name, ...marks }] : [];
    }
    default:
      return [];
  }
}

function marksOf(node: EditorNode): Marks {
  const types = new Set((node.marks ?? []).map((mark) => mark.type));
  const style = node.marks?.find((mark) => mark.type === EDITOR_NODES.textStyle);
  return {
    ...NO_MARKS,
    bold: types.has("bold"),
    italic: types.has("italic"),
    underline: types.has("underline"),
    strike: types.has("strike"),
    superscript: types.has("superscript"),
    subscript: types.has("subscript"),
    size: pointsOf(style?.attrs?.fontSize),
  };
}

/** "12pt" as 12; anything else, including other units, as no size. */
export function pointsOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)\s*pt\s*$/.exec(value);
  if (match === null) return null;
  const points = Number(match[1]);
  return isFontSize(points) ? points : null;
}
