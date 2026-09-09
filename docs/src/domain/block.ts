/**
 * The block tree: how a document's readable content is modelled.
 *
 * It lives in the domain because three places share it — the reader that builds
 * one from a .docx, the preview that renders it, and eventually the writer that
 * turns one back into a document. None of them owns it.
 *
 * It models paragraphs, heading level, emphasis and where the placeholders sit.
 * Deliberately not: page breaks, fonts, images, tables, sections. It is a
 * reading of a document, never a replacement for one.
 */

export type BlockType = "heading1" | "heading2" | "heading3" | "paragraph";

export interface Marks {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}

export const NO_MARKS: Marks = {
  bold: false,
  italic: false,
  underline: false,
};

/** A stretch of literal text, or a placeholder standing in for a value. */
export type Segment =
  | ({ readonly kind: "text"; readonly text: string } & Marks)
  | ({ readonly kind: "placeholder"; readonly name: string } & Marks);

export interface Block {
  readonly type: BlockType;
  readonly segments: readonly Segment[];
}

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
