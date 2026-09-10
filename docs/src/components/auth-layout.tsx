import type { ReactNode } from "react";

import { Brand } from "@/components/brand";
import { LegalFooter } from "@/components/legal-page";

/** The frame both credential screens sit in. */
export function AuthLayout({
  title,
  subtitle,
  summary,
  children,
  footer,
}: {
  readonly title: string;
  readonly subtitle: string;
  /** A problem that belongs to the form as a whole rather than to a field. */
  readonly summary?: string | null;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 px-6 py-16">
        <header className="flex flex-col gap-3">
          {/* Nobody is signed in on these screens, so home is the landing page. */}
          <Brand to="/" className="text-[22px]" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-balance text-2xl font-semibold tracking-[-0.015em]">
              {title}
            </h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </header>

        {/*
          The summary is announced rather than merely shown: a user who submits
          with the keyboard and never looks up would otherwise get no feedback.
        */}
        {summary != null && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
          >
            {summary}
          </p>
        )}

        {children}

        <p className="text-[13px] text-muted-foreground">{footer}</p>
      </main>

      {/*
        The legal links belong here above all: this is the screen where a
        person hands over their data, and a policy they cannot reach from it
        is not published in any way that counts.
      */}
      <LegalFooter />
    </div>
  );
}
