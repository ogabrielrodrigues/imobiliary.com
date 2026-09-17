/**
 * The block tree: how a document's readable content is modelled.
 *
 * It lives in the domain because three places share it — the reader that builds
 * one from a .docx, the preview that renders it, and the writer that turns one
 * back into a document for templates authored in the block editor. None of
 * them owns it.
 *
 * It models what a contract written by hand needs: paragraphs and three heading
 * levels; alignment, indentation, line spacing and lists; page breaks; and on
 * text, bold, italic, underline, strikethrough, superscript, subscript and a
 * font size, plus where the placeholders sit. Deliberately not: fonts, colours,
 * images, tables, headers, footers or sections.
 */

export type BlockType = "heading1" | "heading2" | "heading3" | "paragraph" | "pageBreak";

export type Alignment = "left" | "center" | "right" | "justify";

/** Line spacing as Word offers it: single, its 1.15 default, one and a half, double. */
export const LINE_SPACINGS = [1, 1.15, 1.5, 2] as const;
export type LineSpacing = (typeof LINE_SPACINGS)[number];

export const LIST_KINDS = ["bullet", "ordered"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** Word allows nine list levels, 0 to 8. */
export const MAX_LIST_LEVEL = 8;
/** Steps of left indentation outside a list, 1.25 cm each. */
export const MAX_INDENT = 8;

export interface ListInfo {
  readonly kind: ListKind;
  readonly level: number;
}

/** How a block sits on the page. Every field has a "nothing set" value. */
export interface BlockFormat {
  /** Null follows the style: left. */
  readonly align: Alignment | null;
  /** Null follows the style: 1.15. */
  readonly lineSpacing: LineSpacing | null;
  /** Left indentation in steps, outside lists only. */
  readonly indent: number;
  readonly firstLineIndent: boolean;
  /** Set only on paragraphs. */
  readonly list: ListInfo | null;
}

export const NO_FORMAT: BlockFormat = {
  align: null,
  lineSpacing: null,
  indent: 0,
  firstLineIndent: false,
  list: null,
};

/** The sizes the editor offers, in points. Any size in range is still read. */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36] as const;
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 96;

export interface Marks {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly superscript: boolean;
  readonly subscript: boolean;
  /** Points, or null for the style's size. */
  readonly size: number | null;
}

export const NO_MARKS: Marks = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  superscript: false,
  subscript: false,
  size: null,
};

/** A stretch of literal text, or a placeholder standing in for a value. */
export type Segment =
  | ({ readonly kind: "text"; readonly text: string } & Marks)
  | ({ readonly kind: "placeholder"; readonly name: string } & Marks);

export interface Block {
  readonly type: BlockType;
  readonly segments: readonly Segment[];
  /** Absent means `NO_FORMAT`; the normal form leaves it out in that case. */
  readonly format?: BlockFormat;
}

/** A block's format, with the defaults filled in. */
export function formatOf(block: Block): BlockFormat {
  return block.format ?? NO_FORMAT;
}

/** The size each block type has when no size is set, as the writer's styles define it. */
export const BASE_FONT_SIZE: Record<Exclude<BlockType, "pageBreak">, number> = {
  heading1: 16,
  heading2: 13,
  heading3: 12,
  paragraph: 11,
};

/** Every placeholder a document declares, in the order they first appear. */
export function placeholdersOf(blocks: readonly Block[]): string[] {
  const seen = new Set<string>();

  for (const block of blocks) {
    for (const segment of block.segments) {
      if (segment.kind === "placeholder") seen.add(segment.name);
    }
  }
  return [...seen];
}

/** The plain text of a document, for a summary or a search. */
export function textOf(blocks: readonly Block[]): string {
  return blocks
    .map((block) =>
      block.segments
        .map((segment) =>
          segment.kind === "text" ? segment.text : `{{.${segment.name}}}`,
        )
        .join(""),
    )
    .join("\n");
}

/** Where a list paragraph belongs, and what its marker reads. */
export interface ListPosition {
  /**
   * Which list, counting from 0 in document order. Consecutive list paragraphs
   * form one list until something else interrupts them or the top level
   * changes kind; the writer gives each list its own numbering, so a new list
   * starts again at 1.
   */
  readonly instance: number;
  readonly level: number;
  /**
   * The kind the level has in this list. A .docx numbering defines one kind per
   * level for a whole list, so the first paragraph at a level decides it, and
   * the preview follows the same rule to show what Word will show.
   */
  readonly kind: ListKind;
  /** "•", "◦", "▪", or "1.", "a)", "i." and so on by level. */
  readonly marker: string;
}

const BULLETS = ["•", "◦", "▪"] as const;

/**
 * The list position of every block, or null for blocks outside a list. The
 * preview draws markers with it and the writer numbers with the same grouping,
 * so the two cannot disagree about where a list restarts.
 */
export function listPositions(blocks: readonly Block[]): (ListPosition | null)[] {
  let instance = -1;
  let inList = false;
  let levelKinds: ListKind[] = [];
  let counters: number[] = [];

  return blocks.map((block) => {
    const list = formatOf(block).list;
    if (list === null || block.type !== "paragraph") {
      inList = false;
      return null;
    }

    if (!inList || (list.level === 0 && levelKinds[0] !== undefined && list.kind !== levelKinds[0])) {
      instance += 1;
      levelKinds = [];
      counters = [];
    }
    inList = true;

    const kind = (levelKinds[list.level] ??= list.kind);

    // A deeper item continues its level's count; a shallower one resets
    // everything below it.
    counters = counters.slice(0, list.level + 1);
    while (counters.length <= list.level) counters.push(0);
    counters[list.level] = (counters[list.level] ?? 0) + 1;

    return { instance, level: list.level, kind, marker: marker(kind, list.level, counters[list.level]!) };
  });
}

function marker(kind: ListKind, level: number, count: number): string {
  if (kind === "bullet") return BULLETS[level % BULLETS.length]!;

  switch (level % 3) {
    case 0:
      return `${count}.`;
    case 1:
      return `${letters(count)})`;
    default:
      return `${roman(count)}.`;
  }
}

function letters(count: number): string {
  let out = "";
  let n = count;
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

function roman(count: number): string {
  const numerals: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  let n = count;
  for (const [value, numeral] of numerals) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}
