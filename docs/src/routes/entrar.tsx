import { useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
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
import { validateLogin, validateSecondFactorCode } from "@/domain/user";
import { blurThenChange, formErrors } from "@/lib/form";
import {
  completeSecondFactor,
  currentUser,
  login,
  platformLinks,
  type PlatformLinks,
} from "@/server/auth";
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
      throw redirect({ to: "/dashboard" });
    }
  },
  // The platform's addresses come from the server because the deployment
  // configures them: a link to localhost must never ship in production.
  loader: async () => ({ links: await platformLinks() }),
  head: () =>
    pageSeo({
      title: "Entrar | Imobiliary Docs",
      description:
        "Entre com sua conta Imobiliary para gerar documentos a partir dos seus modelos.",
      path: "/entrar",
      // A sign-in form has nothing to offer someone arriving from a
      // search, and indexing it competes with the page that does.
      noindex: true,
    }),
  component: SignInPage,
});

/**
 * Signing in, in one screen with two steps.
 *
 * The account is the Imobiliary one: this platform holds no password of its
 * own, so creating an account and recovering a password lead to the platform.
 * The second step appears only for an account that carries a second factor,
 * and it replaces the form rather than opening beside it: at that point the
 * password is already accepted and the only question left is the code.
 */
function SignInPage() {
  const { links } = Route.useLoaderData();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // What the server answered. Local checks live in the form; this is only
  // what could not be known without asking.
  const [failure, setFailure] = useState<Failure | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    validationLogic: blurThenChange,
    validators: { onDynamic: ({ value }) => formErrors(validateLogin(value)) },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await login({ data: value });

      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      if (result.value.kind === "second_factor") {
        setChallenge(result.value.challenge);
        return;
      }
      // Whatever this tab cached belonged to whoever was here before.
      queryClient.clear();
      await navigate({ to: "/dashboard" });
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);
  const clearFailure = () => setFailure(null);

  if (challenge !== null) {
    return <SecondFactorStep challenge={challenge} links={links} />;
  }

  return (
    <AuthLayout
      title="Entrar"
      subtitle="Use sua conta Imobiliary para acessar os modelos do escritório."
      summary={summaryOf(failure, {
        // The platform answers 401 for a wrong password and for an unknown
        // address alike, on purpose. Only this screen knows what it can mean.
        authentication: "E-mail ou senha incorretos.",
      })}
      footer={
        <>
          Ainda não tem conta?{" "}
          <a href={links.signUp} className="font-medium text-primary-text">
            Criar conta no imobiliary.com
          </a>
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
              onEdit={clearFailure}
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
              serverError={messageFor(failure, "password")}
              onEdit={clearFailure}
              label="Senha"
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.Field>
        {/*
          Placed under the password rather than in the footer: this is where
          someone is standing when they discover they cannot remember it.
        */}
        <a
          href={links.passwordReset}
          className="-mt-2 self-start text-small text-muted-foreground hover:text-foreground"
        >
          Esqueci minha senha
        </a>
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Entrando…" : "Entrar"}
        </Button>
      </form>
    </AuthLayout>
  );
}

/**
 * The second step: the code from the app, or one of the recovery codes.
 *
 * The challenge is spent by the platform whether the code is right or wrong, so
 * a refused code sends the person back to the password, which is the only way
 * to get another challenge. That is the point: one challenge is one attempt.
 */
function SecondFactorStep({
  challenge,
  links,
}: {
  readonly challenge: string;
  readonly links: PlatformLinks;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<Failure | null>(null);

  const form = useForm({
    defaultValues: { code: "" },
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) => formErrors(validateSecondFactorCode(value.code)),
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await completeSecondFactor({
        data: { challenge, code: value.code },
      });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      queryClient.clear();
      await navigate({ to: "/dashboard" });
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);

  return (
    <AuthLayout
      title="Verificação em duas etapas"
      subtitle="Digite o código do seu aplicativo de autenticação."
      summary={summaryOf(failure, {
        authentication:
          "Código incorreto ou expirado. Entre novamente para tentar de novo.",
      })}
      footer={
        <>
          Perdeu o acesso ao aplicativo? Use um dos códigos de recuperação, ou
          troque o aplicativo em{" "}
          <a href={links.security} className="font-medium text-primary-text">
            ajustes do imobiliary.com
          </a>
          .
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
        <form.Field name="code">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              serverError={messageFor(failure, "code")}
              label="Código"
              placeholder="000000"
              autoComplete="one-time-code"
              autoFocus
              hint="Seis dígitos do aplicativo, ou um código de recuperação."
            />
          )}
        </form.Field>
        <div className="flex items-center justify-between gap-3">
          <Link
            to="/entrar"
            reloadDocument
            className="text-small text-muted-foreground hover:text-foreground"
          >
            Voltar
          </Link>
          <Button type="submit" disabled={pending}>
            {pending ? "Verificando…" : "Verificar"}
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
