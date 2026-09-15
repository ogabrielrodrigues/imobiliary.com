import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

import {
  BASE_FONT_SIZE,
  formatOf,
  listPositions,
  type Block,
  type ListPosition,
  type Marks,
  type Segment,
} from "@/domain/block";
import { humanize, placeholderSyntax } from "@/domain/placeholder";

/** Which placeholder has its input open. One at a time, across the document. */
export interface EditingState {
  readonly editing: boolean;
  readonly onEdit: (name: string | null) => void;
}

/**
 * Draws one placeholder. The caller supplies it, usually a `PlaceholderField`
 * bound to its form, so the preview holds no values of its own and can never
 * disagree with the form about what was typed.
 */
export type RenderPlaceholder = (
  name: string,
  marks: Marks,
  editing: EditingState,
) => ReactNode;

/**
 * The template, shown as a document, with each placeholder editable where it
 * sits.
 *
 * This is a reading of the file, not the file: paragraphs and headings,
 * alignment, indentation, spacing, lists, page breaks and emphasis, nothing
 * more. The document a user downloads is still rendered by the API from the
 * original archive, so anything this leaves out — fonts, images, tables — is
 * missing from the preview only, never from the result.
 */
export function DocumentPreview({
  blocks,
  renderPlaceholder,
}: {
  readonly blocks: readonly Block[];
  readonly renderPlaceholder: RenderPlaceholder;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const positions = useMemo(() => listPositions(blocks), [blocks]);

  return (
    <article
      aria-label="Prévia do documento"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card px-8 py-7 leading-relaxed"
    >
      {blocks.map((block, index) => (
        <BlockView
          // Blocks have no identity of their own; position is what they are.
          key={index}
          blockIndex={index}
          block={block}
          list={positions[index] ?? null}
          editing={editing}
          onEdit={setEditing}
          renderPlaceholder={renderPlaceholder}
        />
      ))}
    </article>
  );
}

const BLOCK_CLASS: Record<Exclude<Block["type"], "pageBreak">, string> = {
  heading1: "text-2xl font-semibold tracking-[-0.015em]",
  heading2: "text-lg font-semibold",
  heading3: "text-lead font-semibold",
  paragraph: "text-sm leading-[1.7]",
};

/** Room for a list marker, per level. */
const LIST_STEP_REM = 1.5;

/**
 * A block's paragraph settings as inline style. Line spacing is Word's
 * multiple times 1.45, so the 1.15 default lands on the 1.7 paragraphs use;
 * one indentation step is 2rem.
 */
function blockStyle(block: Block, list: ListPosition | null): CSSProperties {
  const format = formatOf(block);
  return {
    ...(format.align === null ? {} : { textAlign: format.align }),
    ...(format.lineSpacing === null ? {} : { lineHeight: format.lineSpacing * 1.45 }),
    ...(format.indent === 0 ? {} : { marginLeft: `${format.indent * 2}rem` }),
    ...(format.firstLineIndent ? { textIndent: "2rem" } : {}),
    ...(list === null ? {} : { paddingLeft: `${(list.level + 1) * LIST_STEP_REM}rem`, position: "relative" }),
  };
}

function BlockView({
  blockIndex,
  block,
  list,
  editing,
  onEdit,
  renderPlaceholder,
}: {
  readonly blockIndex: number;
  readonly block: Block;
  readonly list: ListPosition | null;
  /** The occurrence being edited, as "block:segment". */
  readonly editing: string | null;
  readonly onEdit: (occurrence: string | null) => void;
  readonly renderPlaceholder: RenderPlaceholder;
}) {
  if (block.type === "pageBreak") {
    return (
      <div role="separator" aria-label="Quebra de página" className="page-break my-0">
        <span>Quebra de página</span>
      </div>
    );
  }

  const base = BASE_FONT_SIZE[block.type];
  const content = block.segments.map((segment, index) => {
    if (segment.kind === "text") {
      return <TextSpan key={index} segment={segment} base={base} />;
    }

    // Editing is tracked per occurrence, never per name. A placeholder that
    // appears twice would otherwise open two inputs at once; the second
    // steals focus from the first, whose blur commits an empty value and
    // marks both as errors before anyone typed.
    const occurrence = `${blockIndex}:${index}`;
    return (
      <span key={index} className="contents" style={marksStyle(segment, base)}>
        {renderPlaceholder(segment.name, segment, {
          editing: editing === occurrence,
          onEdit: (name) => onEdit(name === null ? null : occurrence),
        })}
      </span>
    );
  });

  const className = BLOCK_CLASS[block.type];
  const style = blockStyle(block, list);

  // An empty paragraph is spacing in the original; keeping it preserves the
  // document's rhythm instead of collapsing it. An empty list item still
  // shows its marker.
  if (block.segments.length === 0 && list === null) {
    return <p className="h-2" aria-hidden="true" />;
  }

  // The marker is drawn, not announced: the text reads the same without it,
  // and a list role on a lone paragraph would be wrong without its list.
  const marker = list !== null && (
    <span
      aria-hidden="true"
      className="absolute text-muted-foreground"
      style={{ left: `${list.level * LIST_STEP_REM}rem` }}
    >
      {list.marker}
    </span>
  );

  switch (block.type) {
    case "heading1":
      return <h2 className={className} style={style}>{content}</h2>;
    case "heading2":
      return <h3 className={className} style={style}>{content}</h3>;
    case "heading3":
      return <h4 className={className} style={style}>{content}</h4>;
    default:
      return (
        <p className={className} style={style}>
          {marker}
          {content}
        </p>
      );
  }
}

function marksClass(marks: Marks): string {
  return cn(
    marks.bold && "font-semibold",
    marks.italic && "italic",
    // One text-decoration utility holds both lines, so they are combined.
    marks.underline && marks.strike
      ? "[text-decoration-line:underline_line-through]"
      : marks.underline
        ? "underline"
        : marks.strike && "line-through",
    marks.superscript && "align-super text-[0.75em]",
    marks.subscript && "align-sub text-[0.75em]",
  );
}

/**
 * A set size, relative to the block's own base size, so a 12pt word in an
 * 11pt paragraph is drawn a little larger than the text around it however
 * large the preview draws that paragraph.
 */
function marksStyle(marks: Marks, base: number): CSSProperties | undefined {
  return marks.size === null ? undefined : { fontSize: `${marks.size / base}em` };
}

function TextSpan({ segment, base }: { readonly segment: Segment & { kind: "text" }; readonly base: number }) {
  // Newlines come from <w:br/>; preserving them keeps a broken line broken.
  return (
    <span className={cn("whitespace-pre-wrap", marksClass(segment))} style={marksStyle(segment, base)}>
      {segment.text}
    </span>
  );
}

/**
 * A placeholder in the flow of the document.
 *
 * Empty, it shows the token so the author can see what the template asks for.
 * Filled, it shows the value. Either way one click puts the caret in it — the
 * form and the document are the same surface, which is the whole point of this
 * layout.
 *
 * Typing goes to a draft, handed over by `onCommit` when the input is left or
 * Enter is pressed: that moment is the field's blur, when a form validates.
 * Escape drops the draft and commits nothing.
 */
export function PlaceholderField({
  name,
  marks,
  value,
  editing,
  invalid,
  onEdit,
  onCommit,
}: {
  readonly name: string;
  readonly marks: Marks;
  readonly value: string;
  readonly editing: boolean;
  readonly invalid: boolean;
  readonly onEdit: (name: string | null) => void;
  readonly onCommit: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      input.current?.focus();
      input.current?.select();
    }
  }, [editing, value]);

  const label = humanize(name);

  if (editing) {
    return (
      <input
        ref={input}
        aria-label={label}
        value={draft}
        size={Math.max(draft.length, label.length) + 1}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          onCommit(draft);
          onEdit(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit(draft);
            onEdit(null);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
            onEdit(null);
          }
        }}
        className={cn(
          // indent-0: an inline-block inherits a first-line indent and would draw it inside itself.
          "mx-0.5 inline-block rounded-[4px] border border-primary bg-input px-1.5 py-0.5 indent-0",
          "text-sm text-foreground outline-none ring-[3px] ring-ring/20",
          marksClass(marks),
        )}
      />
    );
  }

  const filled = value.trim() !== "";

  return (
    <button
      type="button"
      onClick={() => onEdit(name)}
      aria-label={
        filled
          ? `${label}: ${value}. Editar`
          : invalid
            ? `${label}, obrigatório, não preenchido. Preencher`
            : `${label}. Preencher`
      }
      className={cn(
        "mx-0.5 inline-block rounded-[4px] border px-1.5 py-0.5 align-baseline indent-0 transition-colors",
        "focus-visible:ring-[3px] focus-visible:ring-ring/30",
        marksClass(marks),
        invalid
          ? "border-dashed border-destructive/60 bg-destructive/12 text-destructive-soft"
          : filled
            ? "border-success/40 bg-success/12 text-foreground"
            : "border-docs/40 bg-docs/12 font-mono text-xs text-docs-soft",
      )}
    >
      {/*
        Red alone is not a message: the dashed edge and the mark say
        "required" to anyone who cannot tell the colours apart, and the
        label above says it to a screen reader.
      */}
      {invalid && !filled && (
        <span aria-hidden="true" className="mr-1 font-semibold">
          !
        </span>
      )}
      {filled ? value : placeholderSyntax(name)}
    </button>
  );
}
