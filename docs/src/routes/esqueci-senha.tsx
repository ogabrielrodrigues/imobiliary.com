import { useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { AuthLayout } from "@/components/auth-layout";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { validateEmail } from "@/domain/user";
import { blurThenChange, formErrors } from "@/lib/form";
import { currentUser, requestPasswordReset } from "@/server/auth";

export const Route = createFileRoute("/esqueci-senha")({
  beforeLoad: async () => {
    if ((await currentUser()) !== null) {
      throw redirect({ to: "/dashboard" });
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
  const [sent, setSent] = useState(false);

  const form = useForm({
    defaultValues: { email: "" },
    validationLogic: blurThenChange,
    validators: { onDynamic: ({ value }) => formErrors(validateEmail(value.email)) },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await requestPasswordReset({ data: value.email });
      if (result.ok) {
        setSent(true);
        return;
      }
      setFailure(result.failure);
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);

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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        noValidate
        className="flex flex-col gap-5"
      >
        <form.Field name="email">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              serverError={messageFor(failure, "email")}
              onEdit={() => setFailure(null)}
              label="E-mail"
              type="email"
              autoComplete="email"
              autoFocus
            />
          )}
        </form.Field>
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Enviando…" : "Enviar link"}
        </Button>
      </form>
    </AuthLayout>
  );
}
