import { IconAlertCircle, IconUpload } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

import { formatBytes, MAX_TEMPLATE_BYTES } from "@/domain/template";

/** Whether a drag carries files, rather than selected text or a link. */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * The file picker: a template by default, or any other kind of file through
 * `accept`, `title`, `hint` and `badge`.
 *
 * One of only two components the design leaves bespoke. It is built around a
 * real `<input type="file">` inside a `<label>` rather than a div with a click
 * handler: that way the keyboard reaches it, the picker opens on Enter, and
 * assistive technology announces it as the file input it is. Dragging is an
 * enhancement layered on top, never the only way in.
 *
 * **The whole window is the drop target.** As soon as a file is dragged into
 * the page an overlay covers it, so the file can be let go anywhere instead of
 * being aimed at this box. The listeners live on `window` while the component
 * is mounted, which assumes one dropzone per screen, as every screen has.
 */
export function Dropzone({
  file,
  onSelect,
  error,
  accept = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  title = "Arraste o modelo .docx",
  hint = `ou clique para escolher · até ${formatBytes(MAX_TEMPLATE_BYTES)}`,
  badge = "docx",
}: {
  readonly file: File | null;
  readonly onSelect: (file: File | null) => void;
  readonly error?: string | undefined;
  /** What the browser's picker offers. */
  readonly accept?: string;
  readonly title?: string;
  readonly hint?: string;
  /** The short type shown beside a chosen file. */
  readonly badge?: string;
}) {
  const [dragging, setDragging] = useState(false);
  // The latest handler, so the window listeners need not be replaced on every
  // render of the parent.
  const select = useRef(onSelect);
  select.current = onSelect;

  useEffect(() => {
    // dragenter and dragleave fire for every element the pointer crosses, so
    // a count of entries is what tells leaving the window from moving within.
    let depth = 0;

    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser refuses the drop, or opens the file itself
      // in the tab and the work on the page is gone.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const chosen = event.dataTransfer?.files.item(0) ?? null;
      if (chosen) select.current(chosen);
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const overlay = dragging && (
    // Pointer events pass through, so the window keeps receiving the drag and
    // the drop wherever the file is let go.
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-card px-8 py-12 text-center">
        <span className="flex size-12 items-center justify-center rounded-lg border border-border-strong bg-muted text-primary-text">
          <IconUpload className="size-6" />
        </span>
        <span className="text-title-sm font-semibold">Solte o arquivo em qualquer lugar</span>
        <span className="text-small text-muted-foreground">{title}</span>
      </div>
    </div>
  );

  const message =
    error !== undefined && (
      <p className="flex items-start gap-1.5 text-xs text-destructive">
        <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>{error}</span>
      </p>
    );

  if (file) {
    return (
      <div className="flex flex-col gap-2">
        {overlay}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border-strong bg-muted font-mono text-label font-medium text-docs"
          >
            {badge}
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-control font-medium">{file.name}</span>
            <span className="text-xs text-faint">{formatBytes(file.size)}</span>
          </span>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="ml-auto rounded-md px-2.5 py-1.5 text-small text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Trocar
          </button>
        </div>
        {message}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {overlay}
      <label
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
          className="flex size-10 items-center justify-center rounded-md border border-border-strong bg-muted text-docs"
        >
          <IconUpload className="size-5" />
        </span>
        <span className="text-sm font-medium">{title}</span>
        <span className="text-caption text-faint">{hint}</span>
        <input
          type="file"
          name="file"
          accept={accept}
          onChange={(event) => {
            const chosen = event.currentTarget.files?.item(0) ?? null;
            if (chosen) onSelect(chosen);
          }}
          className="sr-only"
        />
      </label>
      {message}
    </div>
  );
}
