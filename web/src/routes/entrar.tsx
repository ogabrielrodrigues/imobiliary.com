import { useState } from "react";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";

import { AuthLayout } from "@/components/auth-layout";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { blurThenChange, formErrors } from "@/lib/form";
import { summaryOf, type Failure } from "@/application/result";
import { validateEmail, validateSecondFactorCode } from "@/domain/user";
import { completeSecondFactor, currentUser, signIn } from "@/server/auth";
import { pageSeo } from "@/lib/seo";

export const Route = createFileRoute("/entrar")({
  // The mirror of the app's guard, inverted: someone already signed in has
  // nothing to do here. Both sides read the same cookie, so they cannot
  // disagree and send each other in a loop.
  beforeLoad: async () => {
    if ((await currentUser()) !== null) {
      throw redirect({ to: "/dashboard" });
    }
  },
  head: () =>
    pageSeo({
      title: "Entrar | Imobiliary",
      description: "Entre na sua conta do Imobiliary.",
      path: "/entrar",
      // A sign-in form has nothing to offer someone arriving from a search,
      // and indexing it competes with the page that does.
      noindex: true,
    }),
  component: SignInPage,
});

/**
 * Signing in, in one screen with two steps.
 *
 * The second step appears only for an account that carries a second factor,
 * and it replaces the form rather than opening beside it: at that point the
 * password is already accepted and the only question left is the code.
 */
function SignInPage() {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);

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
    defaultValues: { email: "", password: "" },
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) => {
        const email = validateEmail(value.email);
        const problems = [
          email,
          value.password === "" ? { field: "password", message: "Informe sua senha." } : null,
        ].filter((problem) => problem !== null);
        return formErrors(problems);
      },
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await signIn({ data: { email: value.email, password: value.password } });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      if (result.value.kind === "second_factor") {
        setChallenge(result.value.challenge);
        return;
      }
      await router.navigate({ to: "/dashboard" });
    },
  });

  const submitted = attempted || form.state.submissionAttempts > 0;

  if (challenge !== null) {
    return <SecondFactorStep challenge={challenge} />;
  }

  return (
    <AuthLayout
      title="Entrar"
      subtitle="Acesse os imóveis, contratos e aluguéis do seu escritório."
      summary={summaryOf(failure, {
        // The API answers 401 for a wrong password and for an unknown address
        // alike, on purpose. Only this screen knows what that can mean here.
        authentication: "E-mail ou senha incorretos.",
        forbidden: "Sua conta não pertence a nenhum escritório. Fale com quem administra o seu.",
      })}
      footer={
        <>
          Ainda não tem conta? <Link to="/criar-conta" className="underline">Criar conta</Link>
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          void form.handleSubmit();
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

        <form.Field name="password">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              label="Senha"
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.Field>

        <div className="flex items-center justify-between gap-3">
          <Link to="/esqueci-senha" className="text-small text-muted-foreground underline">
            Esqueci minha senha
          </Link>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Entrando..." : "Entrar"}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </AuthLayout>
  );
}

/**
 * The second step: the code from the app, or one of the recovery codes.
 *
 * The challenge is spent by the API whether the code is right or wrong, so a
 * refused code sends the person back to the password, which is the only way to
 * get another challenge. That is the point: one challenge is one attempt.
 */
function SecondFactorStep({ challenge }: { readonly challenge: string }) {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);

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
    defaultValues: { code: "" },
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) => formErrors(validateSecondFactorCode(value.code)),
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await completeSecondFactor({ data: { challenge, code: value.code } });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      await router.navigate({ to: "/dashboard" });
    },
  });

  const submitted = attempted || form.state.submissionAttempts > 0;

  return (
    <AuthLayout
      title="Verificação em duas etapas"
      subtitle="Digite o código do seu aplicativo de autenticação."
      summary={summaryOf(failure, {
        authentication: "Código incorreto ou expirado. Entre novamente para tentar de novo.",
      })}
      footer={
        <>
          Perdeu o acesso ao aplicativo? Use um dos códigos de recuperação que você guardou.
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          setAttempted(true);
          void form.handleSubmit();
        }}
      >
        <form.Field name="code">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              label="Código"
              placeholder="000000"
              inputMode="text"
              autoComplete="one-time-code"
              autoFocus
              hint="Seis dígitos do aplicativo, ou um código de recuperação."
            />
          )}
        </form.Field>

        <div className="flex items-center justify-between gap-3">
          <Link to="/entrar" className="text-small text-muted-foreground underline">
            Voltar
          </Link>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Verificando..." : "Verificar"}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </AuthLayout>
  );
}
