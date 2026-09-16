import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { Brand } from "@/components/brand";
import { formatEffectiveDate, type LegalDocument } from "@/domain/legal";
import { MAIN_CONTENT_ID } from "@/components/route-announcer";

/**
 * The frame the legal texts sit in.
 *
 * They are long-form reading rather than interface, so the column is narrower
 * than the rest of the product and the type is a size larger. The version and
 * effective date sit at the top: a reader needs to know which text they are
 * looking at before they read it, not after.
 */
export function LegalPage({
  document,
  children,
}: {
  readonly document: LegalDocument;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <nav
          aria-label="Principal"
          className="mx-auto flex max-w-3xl items-center gap-6 px-6 py-4"
        >
          <Brand to="/" className="text-title-sm" />
        </nav>
      </header>

      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className="outline-none mx-auto w-full max-w-3xl flex-1 px-6">
        <article className="flex flex-col gap-6 py-16">
          <header className="flex flex-col gap-2">
            <h1 className="text-headline font-semibold leading-[1.15] tracking-[-0.02em]">
              {document.title}
            </h1>
            <p className="font-mono text-label tracking-[0.1em] text-faint uppercase">
              Versão {document.version} · em vigor desde{" "}
              {formatEffectiveDate(document.effectiveFrom)}
            </p>
          </header>

          {children}
        </article>
      </main>

      <LegalFooter />
    </div>
  );
}

/** A numbered section of a legal text. */
export function LegalSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="mt-4 text-title-md font-semibold tracking-[-0.01em]">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A paragraph of a legal text, at reading size rather than interface size. */
export function P({ children }: { readonly children: ReactNode }) {
  return (
    <p className="text-lead leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

/** A list where each item is a distinct commitment or category. */
export function LegalList({ children }: { readonly children: ReactNode }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 text-lead leading-relaxed text-muted-foreground marker:text-faint">
      {children}
    </ul>
  );
}

/**
 * The footer carrying the legal links.
 *
 * It is exported so every public surface shows the same one: a policy nobody
 * can find from the page where they hand over their data is not published in
 * any meaningful sense.
 */
export function LegalFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-6 text-small text-faint">
        <span>Imobiliary</span>
        <Link to="/privacidade" className="ml-auto hover:text-foreground">
          Política de Privacidade
        </Link>
        <Link to="/termos" className="hover:text-foreground">
          Termos de Uso
        </Link>
        <Link to="/licencas" className="hover:text-foreground">
          Licenças
        </Link>
      </div>
    </footer>
  );
}
