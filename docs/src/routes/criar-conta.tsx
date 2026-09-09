import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { MIN_PASSWORD_LENGTH } from "@/domain/user";
import { AuthLayout } from "@/components/auth-layout";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { register } from "@/server/auth";

export const Route = createFileRoute("/criar-conta")({
  head: () => ({
    meta: [
      { title: "Criar conta — Imobiliary Docs" },
      {
        name: "description",
        content:
          "Crie sua conta para enviar modelos do Word e gerar documentos preenchidos.",
      },
    ],
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
        },
      });

      if (result.ok) {
        // Registering does not open a session — the API keeps the two apart —
        // so the next step is signing in.
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
          <Link to="/entrar" className="font-medium text-primary">
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
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Criando…" : "Criar conta"}
        </Button>
      </form>
    </AuthLayout>
  );
}
