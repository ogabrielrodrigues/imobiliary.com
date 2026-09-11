import { IconAlertCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { summaryOf, type Failure } from "@/application/result";
import { MAIN_CONTENT_ID } from "@/components/route-announcer";

/** The bar across the top of every screen inside the shell. */
export function PageHeader({
  title,
  actions,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3.5">
      <h1 className="text-lg font-semibold">{title}</h1>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </header>
  );
}

/**
 * The scrolling region of a screen. Every route inside the app shell renders a
 * PageHeader and a PageBody and nothing else, which is what keeps the header
 * pinned: as siblings in a column flex container, only this one scrolls.
 *
 * min-h-0 is what makes that work. A flex-1 item in a column container has a
 * vertical main axis, so its default min-height of auto refuses to shrink below
 * its content — it grows past the shell and overflow-y-auto never engages.
 *
 * It is also the <main> of every screen inside the app: the landmark a screen
 * reader jumps to, the skip link's target, and where focus lands after a
 * navigation. tabIndex -1 lets it take that focus without joining the tab
 * order; it draws no ring, being a region and not a control.
 */
export function PageBody({ children }: { readonly children: ReactNode }) {
  return (
    <main
      id={MAIN_CONTENT_ID}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5 outline-none"
    >
      {children}
    </main>
  );
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
      className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card px-5 py-6 text-sm text-muted-foreground"
    >
      <span className="flex items-start gap-2.5">
        <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span>{summaryOf(failure) ?? "Não foi possível carregar."}</span>
      </span>
      {/*
        A session that expired mid-visit is the one failure the user can act on,
        and without a way out this card is a dead end: the cookie is cleared by
        the time it renders, so nothing on screen leads back to signing in.
      */}
      {failure.kind === "authentication" && (
        <Link
          to="/entrar"
          className="rounded-md text-small font-semibold text-primary hover:underline"
        >
          Entrar novamente
        </Link>
      )}
    </div>
  );
}

/** The card shown when a list is legitimately empty. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  /** Decorative; the title says what the state is. */
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card px-5 py-6">
      {icon && (
        <span
          aria-hidden="true"
          className="flex size-9 items-center justify-center rounded-md border border-border-strong bg-muted text-muted-foreground [&_svg]:size-5"
        >
          {icon}
        </span>
      )}
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-prose text-caption leading-relaxed text-muted-foreground">
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
export function DocxIcon({
  size = 34,
}: {
  /** In px at the default font size; rendered in rem so it grows with the text. */
  readonly size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }}
      className="flex shrink-0 items-center justify-center rounded-md border border-border-strong bg-muted font-mono text-micro font-medium text-docs"
    >
      docx
    </span>
  );
}
