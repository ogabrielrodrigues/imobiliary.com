import { useState } from "react";
import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";

import { summaryOf, type Failure } from "@/application/result";
import { AuthLayout } from "@/components/auth-layout";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH, validateRegistration } from "@/domain/user";
import { blurThenChange, formErrors, visibleError } from "@/lib/form";
import { pageSeo } from "@/lib/seo";
import { currentUser, register } from "@/server/auth";

export const Route = createFileRoute("/criar-conta")({
  beforeLoad: async () => {
    if ((await currentUser()) !== null) {
      throw redirect({ to: "/dashboard" });
    }
  },
  head: () =>
    pageSeo({
      title: "Criar conta | Imobiliary",
      description:
        "Abra a conta do seu escritório e comece a cadastrar imóveis, contratos e aluguéis.",
      path: "/criar-conta",
    }),
  component: RegisterPage,
});

/**
 * Opening an account also opens the office it administers.
 *
 * The account created here is an administrator, which the API requires to
 * carry a second factor: the first sign-in leads straight to the setup screen,
 * and the copy here says so rather than letting it be a surprise.
 */
function RegisterPage() {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);

  const form = useForm({
    defaultValues: {
      name: "",
      email: "",
      organization_name: "",
      password: "",
      terms: false,
    },
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) =>
        formErrors(
          validateRegistration({
            name: value.name,
            email: value.email,
            organizationName: value.organization_name,
            password: value.password,
            acceptedTerms: value.terms,
          }),
        ),
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await register({
        data: {
          name: value.name,
          email: value.email,
          password: value.password,
          organizationName: value.organization_name,
          acceptedTerms: value.terms,
        },
      });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      // The API deliberately does not sign anyone in here, and answers the
      // same whether or not the address was taken. Sending everyone to the
      // sign-in screen keeps that true in the interface as well.
      await router.navigate({ to: "/entrar" });
    },
  });

  const submitted = form.state.submissionAttempts > 0;

  return (
    <AuthLayout
      title="Criar conta"
      subtitle="Abra a conta do escritório. Você será o administrador dele."
      summary={summaryOf(failure)}
      footer={
        <>
          Já tem conta? <Link to="/entrar" className="underline">Entrar</Link>
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="name">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              label="Seu nome"
              autoComplete="name"
              autoFocus
            />
          )}
        </form.Field>

        <form.Field name="email">
          {(field) => (
            <BoundFormField field={field} submitted={submitted} label="E-mail" type="email" autoComplete="email" />
          )}
        </form.Field>

        <form.Field name="organization_name">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              label="Nome do escritório"
              autoComplete="organization"
              hint="Aparece no topo da plataforma e nos convites que você enviar."
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
              autoComplete="new-password"
              hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
            />
          )}
        </form.Field>

        <form.Field name="terms">
          {(field) => {
            // `required` does nothing under noValidate, so the checkbox is a
            // validated field like any other; in docs it was left unchecked
            // and nothing enforced it.
            const error = visibleError(field.state.meta, submitted);
            return (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    id="terms"
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked === true)}
                    onBlur={field.handleBlur}
                    aria-invalid={error !== undefined}
                  />
                  <Label htmlFor="terms" className="text-small font-normal text-muted-foreground">
                    Li e aceito os{" "}
                    <Link to="/termos" className="underline">
                      Termos de Uso
                    </Link>{" "}
                    e a{" "}
                    <Link to="/privacidade" className="underline">
                      Política de Privacidade
                    </Link>
                    .
                  </Label>
                </div>
                {error !== undefined && <p className="text-xs text-destructive">{error}</p>}
              </div>
            );
          }}
        </form.Field>

        <p className="text-small text-muted-foreground">
          Depois de entrar, o administrador precisa ativar a verificação em duas etapas. Tenha um
          aplicativo de autenticação à mão.
        </p>

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting} className="self-start">
              {isSubmitting ? "Criando..." : "Criar conta"}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthLayout>
  );
}
