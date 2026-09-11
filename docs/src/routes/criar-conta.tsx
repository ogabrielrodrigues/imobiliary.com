import { useId, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import type { FieldError } from "@/domain/errors";
import { CURRENT_TERMS_VERSION } from "@/domain/legal";
import { MIN_PASSWORD_LENGTH, validateRegistration } from "@/domain/user";
import { AuthLayout } from "@/components/auth-layout";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { blurThenChange, formErrors, visibleError } from "@/lib/form";
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

interface SignUpValues {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly terms: boolean;
}

/**
 * The domain's registration rules, plus the one this screen adds: the terms
 * must be accepted.
 *
 * The checkbox used to rely on `required`, which the form's `noValidate`
 * switched off, so nothing actually stopped a submit without it.
 */
function signUpErrors(value: SignUpValues) {
  const fields: FieldError[] = [
    ...(validateRegistration({ ...value, termsVersion: CURRENT_TERMS_VERSION })?.fields ?? []),
  ];
  if (!value.terms) {
    fields.push({
      field: "terms",
      message: "Aceite os Termos de Uso e a Política de Privacidade para continuar.",
    });
  }
  return formErrors(fields);
}

function SignUpPage() {
  const navigate = useNavigate();
  const [failure, setFailure] = useState<Failure | null>(null);
  const termsMessageId = useId();

  const form = useForm({
    defaultValues: { name: "", email: "", password: "", terms: false } as SignUpValues,
    validationLogic: blurThenChange,
    validators: { onDynamic: ({ value }) => signUpErrors(value) },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await register({
        data: {
          email: value.email,
          name: value.name,
          password: value.password,
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
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);
  const clearFailure = () => setFailure(null);

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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        noValidate
        className="flex flex-col gap-5"
      >
        <form.Field name="name">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              serverError={messageFor(failure, "name")}
              onEdit={clearFailure}
              label="Nome"
              autoComplete="name"
              autoFocus
            />
          )}
        </form.Field>
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
              autoComplete="new-password"
              hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
            />
          )}
        </form.Field>

        {/*
          A real checkbox, so a screen reader announces it as a choice. The
          acceptance is recorded server-side with its version.
        */}
        <form.Field name="terms">
          {(field) => {
            const error = visibleError(field.state.meta, submitted);
            return (
              <div className="flex flex-col gap-1.5">
                <label className="flex items-start gap-2.5 text-small leading-relaxed text-muted-foreground">
                  <input
                    type="checkbox"
                    name={field.name}
                    checked={field.state.value}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      clearFailure();
                      field.handleChange(checked);
                    }}
                    onBlur={field.handleBlur}
                    aria-required="true"
                    aria-invalid={error !== undefined}
                    {...(error === undefined ? {} : { "aria-describedby": termsMessageId })}
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
                {error !== undefined && (
                  <p id={termsMessageId} className="text-xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
            );
          }}
        </form.Field>

        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Criando…" : "Criar conta"}
        </Button>
      </form>
    </AuthLayout>
  );
}
