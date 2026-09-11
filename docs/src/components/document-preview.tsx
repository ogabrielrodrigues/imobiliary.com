import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

import type { Block, Marks, Segment } from "@/domain/block";
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
 * This is a reading of the file, not the file: paragraphs, heading level and
 * emphasis, nothing more. The document a user downloads is still rendered by
 * the API from the original archive, so anything this leaves out — page breaks,
 * fonts, images, tables — is missing from the preview only, never from the
 * result.
 */
export function DocumentPreview({
  blocks,
  renderPlaceholder,
}: {
  readonly blocks: readonly Block[];
  readonly renderPlaceholder: RenderPlaceholder;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <article
      aria-label="Prévia do documento"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card px-8 py-7 leading-relaxed"
    >
      {blocks.map((block, index) => (
        <BlockView
          // Blocks have no identity of their own; position is what they are.
          key={index}
          block={block}
          editing={editing}
          onEdit={setEditing}
          renderPlaceholder={renderPlaceholder}
        />
      ))}
    </article>
  );
}

const BLOCK_CLASS: Record<Block["type"], string> = {
  heading1: "text-2xl font-semibold tracking-[-0.015em]",
  heading2: "text-lg font-semibold",
  heading3: "text-lead font-semibold",
  paragraph: "text-sm leading-[1.7]",
};

function BlockView({
  block,
  editing,
  onEdit,
  renderPlaceholder,
}: {
  readonly block: Block;
  readonly editing: string | null;
  readonly onEdit: (name: string | null) => void;
  readonly renderPlaceholder: RenderPlaceholder;
}) {
  const content = block.segments.map((segment, index) =>
    segment.kind === "text" ? (
      <TextSpan key={index} segment={segment} />
    ) : (
      <span key={index} className="contents">
        {renderPlaceholder(segment.name, segment, {
          editing: editing === segment.name,
          onEdit,
        })}
      </span>
    ),
  );

  const className = BLOCK_CLASS[block.type];

  // An empty paragraph is spacing in the original; keeping it preserves the
  // document's rhythm instead of collapsing it.
  if (block.segments.length === 0) {
    return <p className="h-2" aria-hidden="true" />;
  }

  switch (block.type) {
    case "heading1":
      return <h2 className={className}>{content}</h2>;
    case "heading2":
      return <h3 className={className}>{content}</h3>;
    case "heading3":
      return <h4 className={className}>{content}</h4>;
    default:
      return <p className={className}>{content}</p>;
  }
}

function marksClass(marks: Marks): string {
  return cn(
    marks.bold && "font-semibold",
    marks.italic && "italic",
    marks.underline && "underline",
  );
}

function TextSpan({ segment }: { readonly segment: Segment & { kind: "text" } }) {
  // Newlines come from <w:br/>; preserving them keeps a broken line broken.
  return (
    <span className={cn("whitespace-pre-wrap", marksClass(segment))}>
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
          "mx-0.5 inline-block rounded-[4px] border border-primary bg-input px-1.5 py-0.5",
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
        "mx-0.5 inline-block rounded-[4px] border px-1.5 py-0.5 align-baseline transition-colors",
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
