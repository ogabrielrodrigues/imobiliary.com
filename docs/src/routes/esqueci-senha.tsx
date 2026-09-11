import { useState, type FormEvent } from "react";
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
import { currentUser, requestPasswordReset } from "@/server/auth";

export const Route = createFileRoute("/esqueci-senha")({
  beforeLoad: async () => {
    if ((await currentUser()) !== null) {
      throw redirect({ to: "/templates" });
    }
  },
  head: () => ({
    meta: [
      { title: "Esqueci minha senha | Imobiliary Docs" },
      {
        name: "description",
        content:
          "Receba um link por e-mail para escolher uma nova senha de acesso.",
      },
    ],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    setPending(true);
    setFailure(null);

    try {
      const result = await requestPasswordReset({
        data: String(form.get("email") ?? ""),
      });
      if (result.ok) {
        setSent(true);
        return;
      }
      setFailure(result.failure);
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <AuthLayout
        title="Verifique seu e-mail"
        subtitle="Se o endereço tiver uma conta aqui, o link já está a caminho."
        footer={
          <>
            Lembrou a senha?{" "}
            <Link to="/entrar" className="font-medium text-primary-text">
              Entrar
            </Link>
          </>
        }
      >
        {/*
          Deliberately non-committal about whether an account exists. The API
          answers the same either way, and a screen that said "enviamos para
          fulano@..." would undo that in one sentence: anyone could use this
          form to find out who has an account here.
        */}
        <div className="flex flex-col gap-4">
          <p className="text-control leading-relaxed text-muted-foreground">
            O link vale por 30 minutos e só pode ser usado uma vez. Se não
            chegar, confira a caixa de spam antes de pedir outro.
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate({ to: "/entrar" })}
          >
            Voltar para o login
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Esqueci minha senha"
      subtitle="Informe seu e-mail e enviaremos um link para escolher uma nova."
      summary={summaryOf(failure)}
      footer={
        <>
          Lembrou a senha?{" "}
          <Link to="/entrar" className="font-medium text-primary-text">
            Entrar
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
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Enviando…" : "Enviar link"}
        </Button>
      </form>
    </AuthLayout>
  );
}
