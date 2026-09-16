import { createFileRoute, Link } from "@tanstack/react-router";

import { Brand } from "@/components/brand";
import { LegalFooter } from "@/components/legal-page";
import { Button } from "@/components/ui/button";
import { MAIN_CONTENT_ID } from "@/components/route-announcer";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/")({
  head: () =>
    pageSeo({
      title: "Imobiliary: gestão de imóveis para locação",
      description:
        "Contratos, reajustes e aluguéis de um escritório de imóveis, em um " +
        "lugar só, com os prazos à vista.",
      path: "/",
    }),
  component: LandingPage,
});

/**
 * The landing page, still provisional.
 *
 * It says what the product is and offers the two ways in. The pitch is written
 * properly in phase 1, together with the screens it leads to; what matters
 * here is that the frame, the themes and the accessibility preferences are
 * real from the first commit.
 */
function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-4 py-4 md:px-8">
        <Brand />
        <Button nativeButton={false} render={<Link to="/entrar" />} variant="secondary" size="sm">
          Entrar
        </Button>
      </header>

      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex-1 px-4 py-16 md:px-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          <h1 className="text-headline font-semibold tracking-tight md:text-display">
            Os imóveis, os contratos e os aluguéis do escritório em um lugar só
          </h1>
          <p className="max-w-xl font-reading text-lead text-muted-foreground">
            Cadastre imóveis e pessoas uma vez, acompanhe os vencimentos do dia
            e registre os pagamentos sem planilha paralela.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button nativeButton={false} render={<Link to="/criar-conta" />}>
              Criar conta
            </Button>
            <Button variant="secondary" nativeButton={false} render={<Link to="/entrar" />}>
              Entrar
            </Button>
          </div>
        </div>
      </main>

      <LegalFooter />
    </div>
  );
}
