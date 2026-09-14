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
import { validateLogin } from "@/domain/user";
import { blurThenChange, formErrors } from "@/lib/form";
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
      throw redirect({ to: "/dashboard" });
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
  const queryClient = useQueryClient();
  // What the server answered. Local checks live in the form; this is only
  // what could not be known without asking.
  const [failure, setFailure] = useState<Failure | null>(null);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    validationLogic: blurThenChange,
    validators: { onDynamic: ({ value }) => formErrors(validateLogin(value)) },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await login({ data: value });

      if (result.ok) {
        // Whatever this tab cached belonged to whoever was here before.
        queryClient.clear();
        await navigate({ to: "/dashboard" });
        return;
      }
      setFailure(result.failure);
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);
  const clearFailure = () => setFailure(null);

  return (
    <AuthLayout
      title="Entrar"
      subtitle="Use a conta que você criou para acessar seus modelos."
      summary={summaryOf(failure, { authentication: "E-mail ou senha incorretos." })}
      footer={
        <>
          Ainda não tem conta?{" "}
          <Link to="/criar-conta" className="font-medium text-primary-text">
            Criar conta
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
              onEdit={clearFailure}
              label="E-mail"
              type="email"
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
