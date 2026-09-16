import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";

import { summaryOf, type Failure } from "@/application/result";
import { AuthLayout } from "@/components/auth-layout";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { validateEmail } from "@/domain/user";
import { blurThenChange, formErrors, submitForm } from "@/lib/form";
import { pageSeo } from "@/lib/seo";
import { forgotPassword } from "@/server/password";

export const Route = createFileRoute("/esqueci-senha")({
  head: () =>
    pageSeo({
      title: "Esqueci minha senha | Imobiliary",
      description: "Receba um link para definir uma nova senha.",
      path: "/esqueci-senha",
      noindex: true,
    }),
  component: ForgotPasswordPage,
});

/**
 * Asking for a reset link.
 *
 * The confirmation is the same for an address with an account and one without,
 * because the API answers the same: telling them apart here would turn this
 * form into a way to ask who has an account.
 */
function ForgotPasswordPage() {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [sent, setSent] = useState(false);

  /*
    Whether the form has been submitted, for the rule that shows every error.

    `submissionAttempts` is not enough on its own: when validation blocks the
    submission, the form never counts the attempt, so an error on a field
    nobody has left stays hidden and the button appears to do nothing. That is
    exactly what the terms checkbox did. Tracking the attempt here makes the
    form answer the first click, every time.
  */
  const [attempted, setAttempted] = useState(false);

  const form = useForm({
    defaultValues: { email: "" },
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) => formErrors([validateEmail(value.email)].filter((problem) => problem !== null)),
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await forgotPassword({ data: value.email });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      setSent(true);
    },
  });

  const submitted = attempted || form.state.submissionAttempts > 0;

  if (sent) {
    return (
      <AuthLayout
        title="Verifique seu e-mail"
        subtitle="Se houver uma conta com esse endereço, o link para definir uma nova senha chega em instantes."
        footer={
          <>
            O link vale por 30 minutos e só pode ser usado uma vez.{" "}
            <Link to="/entrar" className="underline">
              Voltar para entrar
            </Link>
          </>
        }
      >
        <p className="text-small text-muted-foreground">
          Não recebeu? Verifique a caixa de spam antes de pedir outro link.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Esqueci minha senha"
      subtitle="Informe seu e-mail e enviaremos um link para definir uma nova."
      summary={summaryOf(failure)}
      footer={
        <>
          Lembrou a senha? <Link to="/entrar" className="underline">Entrar</Link>
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          void submitForm(form);
        }}
      >
        <form.Field name="email">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              label="E-mail"
              type="email"
              placeholder="nome@exemplo.com"
              autoComplete="email"
              autoFocus
            />
          )}
        </form.Field>

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting} className="self-start">
              {isSubmitting ? "Enviando..." : "Enviar link"}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthLayout>
  );
}
