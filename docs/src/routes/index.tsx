import { createFileRoute, Link } from "@tanstack/react-router";

import { Brand } from "@/components/brand";
import { LegalFooter } from "@/components/legal-page";
import { currentUser } from "@/server/auth";

export const Route = createFileRoute("/")({
  /**
   * Who is looking, so the page can offer the right next step.
   *
   * A loader rather than a `beforeLoad`: there is no redirect to decide here,
   * only a fact to render. `currentUser` reads the session cookie and answers
   * `null` for a visitor without one — an ordinary answer, never a failure — so
   * nothing here can throw a signed-out visitor off the landing page.
   *
   * The page does become a per-visitor response because of this. A crawler
   * arrives without a cookie and still gets exactly the HTML it got before, so
   * search is unaffected; a shared cache in front of this would have to vary on
   * the session cookie.
   */
  loader: () => currentUser(),
  head: () => ({
    meta: [
      { title: "Imobiliary Docs — contratos a partir dos seus modelos" },
      {
        name: "description",
        content:
          "Envie um modelo do Word com campos marcados. A plataforma descobre " +
          "os campos sozinha e gera o documento preenchido, pronto para baixar.",
      },
    ],
  }),
  component: LandingPage,
});

function LandingPage() {
  const user = Route.useLoaderData();
  const signedIn = user !== null;

  return (
    // A column so the footer is pushed to the bottom of the viewport. Without
    // it, a page shorter than the screen leaves the footer stranded mid-page
    // with a void beneath it, which reads as one enormous footer.
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <nav
          aria-label="Principal"
          className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4"
        >
          <Brand to="/" className="text-[18px]" />
          {/*
            Someone already signed in has no use for a sign-in link, and
            offering one invites them to authenticate over their own session.
          */}
          <Link
            to={signedIn ? "/templates" : "/entrar"}
            className="ml-auto rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            {signedIn ? "Ir para meus modelos" : "Entrar"}
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6">
        <section
          aria-labelledby="hero-title"
          className="flex flex-col items-start gap-6 py-20"
        >
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-faint">
            Documentos padronizados
          </p>
          <h1
            id="hero-title"
            className="max-w-2xl text-balance text-[34px] font-semibold leading-[1.15] tracking-[-0.025em]"
          >
            Seus contratos, preenchidos sozinhos.
          </h1>
          <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Envie um modelo <code className="font-mono text-docs">.docx</code>{" "}
            com os campos marcados. A plataforma descobre quais são, monta o
            formulário e devolve o documento pronto — com a formatação do Word
            intacta.
          </p>
          {/*
            The pitch above stays as it is: it describes the product, which
            reads correctly whether or not the visitor already has an account.
            Only the call to action has to know.
          */}
          <Link
            to={signedIn ? "/templates" : "/criar-conta"}
            className="rounded-md bg-primary px-4 py-[9px] text-[13.5px] font-semibold text-primary-foreground"
          >
            {signedIn ? "Abrir meus modelos" : "Criar conta"}
          </Link>
        </section>
      </main>

      <LegalFooter />
    </div>
  );
}
