import { useState } from "react";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { CURRENT_TERMS_VERSION } from "@/domain/legal";
import { MIN_PASSWORD_LENGTH } from "@/domain/user";
import { AuthLayout } from "@/components/auth-layout";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { currentUser, register } from "@/server/auth";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/criar-conta")({
  /**
   * The mirror of the guard on `_app`: someone who already has a session has
   * no business on a credential screen, and signing in over a live session
   * would replace it for no reason.
   *
   * No loop with that guard — both read the same cookie, so they cannot
   * disagree about whether a session exists.
   */
  beforeLoad: async () => {
    if ((await currentUser()) !== null) {
      throw redirect({ to: "/dashboard" });
    }
  },
  head: () =>
    pageSeo({
      title: "Criar conta | Imobiliary Docs",
      description:
        "Crie sua conta para enviar modelos do Word e gerar documentos preenchidos.",
      path: "/criar-conta",
    }),
  component: SignUpPage,
});

function SignUpPage() {
  const navigate = useNavigate();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    setPending(true);
    setFailure(null);

    try {
      const result = await register({
        data: {
          email: String(form.get("email") ?? ""),
          name: String(form.get("name") ?? ""),
          password: String(form.get("password") ?? ""),
          // Recorded with the account: which text was agreed to matters as
          // much as the fact that something was.
          termsVersion: CURRENT_TERMS_VERSION,
        },
      });

      if (result.ok) {
        // Registering does not open a session — the API keeps the two apart —
        // so the next step is signing in. The same happens when the address
        // already had an account: its owner is told by email, and this screen
        // says nothing that would distinguish the two cases.
        await navigate({ to: "/entrar" });
        return;
      }
      setFailure(result.failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Criar conta"
      subtitle="Leva um minuto. Depois é só enviar seu primeiro modelo."
      summary={summaryOf(failure)}
      footer={
        <>
          Já tem conta?{" "}
          <Link to="/entrar" className="font-medium text-primary-text">
            Entrar
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <FormField
          name="name"
          label="Nome"
          autoComplete="name"
          autoFocus
          error={messageFor(failure, "name")}
        />
        <FormField
          name="email"
          label="E-mail"
          type="email"
          autoComplete="email"
          error={messageFor(failure, "email")}
        />
        <FormField
          name="password"
          label="Senha"
          type="password"
          autoComplete="new-password"
          hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
          error={messageFor(failure, "password")}
        />
        {/*
          A real checkbox, required, so the browser refuses the form before
          any request is made and a screen reader announces it as a choice.
          The acceptance is recorded server-side with its version.
        */}
        <label className="flex items-start gap-2.5 text-small leading-relaxed text-muted-foreground">
          <input
            type="checkbox"
            name="terms"
            required
            className="mt-0.5 size-4 shrink-0 rounded-[4px] border border-border-strong bg-input accent-primary"
          />
          <span>
            Li e aceito os{" "}
            <Link to="/termos" className="font-medium text-primary-text hover:underline">
              Termos de Uso
            </Link>{" "}
            e a{" "}
            <Link to="/privacidade" className="font-medium text-primary-text hover:underline">
              Política de Privacidade
            </Link>
            .
          </span>
        </label>

        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Criando…" : "Criar conta"}
        </Button>
      </form>
    </AuthLayout>
  );
}
