import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
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
  return (
    <div className="min-h-dvh">
      <header className="border-b border-border">
        <nav
          aria-label="Principal"
          className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4"
        >
          <Brand />
          <Link
            to="/"
            className="ml-auto rounded-md px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            Entrar
          </Link>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6">
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
          <Link
            to="/"
            className="rounded-md bg-primary px-4 py-[9px] text-[13.5px] font-semibold text-primary-foreground"
          >
            Criar conta
          </Link>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-5xl px-6 py-6 text-[13px] text-faint">
          Uma subplataforma do Imobiliary.
        </div>
      </footer>
    </div>
  );
}

/**
 * The wordmark is always lowercase, and "docs" always carries the subapplication
 * colour — it never appears on its own.
 */
function Brand() {
  return (
    <span className="text-[18px] font-semibold tracking-[-0.02em]">
      imobiliary <span className="text-docs">docs</span>
    </span>
  );
}
