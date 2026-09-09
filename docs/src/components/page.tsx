import type { ReactNode } from "react";

import { summaryOf, type Failure } from "@/application/result";

/** The bar across the top of every screen inside the shell. */
export function PageHeader({
  title,
  actions,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-5 py-3.5">
      <h1 className="text-lg font-semibold">{title}</h1>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PageBody({ children }: { readonly children: ReactNode }) {
  return <div className="flex flex-1 flex-col gap-4 p-5">{children}</div>;
}

/**
 * What a screen shows when its data could not be loaded.
 *
 * It states what failed and leaves the user somewhere they can act, rather than
 * an empty page that looks like they simply have nothing.
 */
export function LoadFailure({ failure }: { readonly failure: Failure }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-border bg-card px-5 py-6 text-sm text-muted-foreground"
    >
      {summaryOf(failure) ?? "Não foi possível carregar."}
    </div>
  );
}

/** The card shown when a list is legitimately empty. */
export function EmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card px-5 py-6">
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-prose text-[12.5px] leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action}
    </div>
  );
}

/**
 * A status pill.
 *
 * Only the states the API actually sustains exist here. A generated document is
 * always ready; there is no draft, no archive and no stored failure, so those
 * badges from the design have no counterpart and are deliberately absent.
 */
export function StatusPill({
  tone,
  children,
}: {
  readonly tone: "success" | "docs" | "primary" | "neutral";
  readonly children: ReactNode;
}) {
  const tones = {
    success: "bg-success/15 border-success/35 text-success",
    docs: "bg-docs/15 border-docs/35 text-docs",
    primary: "bg-primary/15 border-primary/35 text-primary",
    neutral: "bg-muted border-border-strong text-muted-foreground",
  } as const;

  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** The small square that marks a .docx, as the design draws it. */
export function DocxIcon({ size = 34 }: { readonly size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="flex shrink-0 items-center justify-center rounded-md border border-border-strong bg-muted font-mono text-[10px] font-medium text-docs"
    >
      docx
    </span>
  );
}
