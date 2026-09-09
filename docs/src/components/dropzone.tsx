import { useState } from "react";
import { cn } from "cn";

import { formatBytes, MAX_TEMPLATE_BYTES } from "@/domain/template";

/**
 * The file picker for a template.
 *
 * One of only two components the design leaves bespoke. It is built around a
 * real `<input type="file">` inside a `<label>` rather than a div with a click
 * handler: that way the keyboard reaches it, the picker opens on Enter, and
 * assistive technology announces it as the file input it is. Dragging is an
 * enhancement layered on top, never the only way in.
 */
export function Dropzone({
  file,
  onSelect,
  error,
}: {
  readonly file: File | null;
  readonly onSelect: (file: File | null) => void;
  readonly error?: string | undefined;
}) {
  const [dragging, setDragging] = useState(false);

  function take(list: FileList | null) {
    const chosen = list?.item(0) ?? null;
    if (chosen) onSelect(chosen);
  }

  if (file) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border-strong bg-muted font-mono text-[11px] font-medium text-docs"
          >
            docx
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[13.5px] font-medium">
              {file.name}
            </span>
            <span className="text-xs text-faint">{formatBytes(file.size)}</span>
          </span>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="ml-auto rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Trocar
          </button>
        </div>
        {error !== undefined && (
          <p className="text-xs text-destructive">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          take(event.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-2.5 rounded-lg border border-dashed px-6 py-8 text-center transition-colors",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20",
          dragging
            ? "border-primary bg-primary/5"
            : error === undefined
              ? "border-border-hover bg-card hover:bg-row-hover"
              : "border-destructive/70 bg-card",
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-md border border-border-strong bg-muted font-mono text-[11px] font-medium text-docs"
        >
          docx
        </span>
        <span className="text-sm font-medium">Arraste o modelo .docx</span>
        <span className="text-[12.5px] text-faint">
          ou clique para escolher · até {formatBytes(MAX_TEMPLATE_BYTES)}
        </span>
        <input
          type="file"
          name="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(event) => take(event.currentTarget.files)}
          className="sr-only"
        />
      </label>
      {error !== undefined && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
