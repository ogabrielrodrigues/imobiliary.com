import { useState } from "react";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { AuthLayout } from "@/components/auth-layout";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { currentUser, login } from "@/server/auth";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/entrar")({
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
      throw redirect({ to: "/templates" });
    }
  },
  head: () =>
    pageSeo({
      title: "Entrar | Imobiliary Docs",
      description:
        "Acesse sua conta para gerar documentos a partir dos seus modelos.",
      path: "/entrar",
      // A sign-in form has nothing to offer someone arriving from a
      // search, and indexing it competes with the page that does.
      noindex: true,
    }),
  component: SignInPage,
});

function SignInPage() {
  const navigate = useNavigate();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    setPending(true);
    setFailure(null);

    try {
      const result = await login({
        data: {
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        },
      });

      if (result.ok) {
        await navigate({ to: "/templates" });
        return;
      }
      setFailure(result.failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Entrar"
      subtitle="Use a conta que você criou para acessar seus modelos."
      summary={summaryOf(failure)}
      footer={
        <>
          Ainda não tem conta?{" "}
          <Link to="/criar-conta" className="font-medium text-primary">
            Criar conta
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <FormField
          name="email"
          label="E-mail"
          type="email"
          autoComplete="email"
          autoFocus
          error={messageFor(failure, "email")}
        />
        <FormField
          name="password"
          label="Senha"
          type="password"
          autoComplete="current-password"
          error={messageFor(failure, "password")}
        />
        {/*
          Placed under the password rather than in the footer: this is where
          someone is standing when they discover they cannot remember it.
        */}
        <Link
          to="/esqueci-senha"
          className="-mt-2 self-start text-small text-muted-foreground hover:text-foreground"
        >
          Esqueci minha senha
        </Link>
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </AuthLayout>
  );
}
