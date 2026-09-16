import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";

import { summaryOf, type Failure } from "@/application/result";
import { AuthLayout } from "@/components/auth-layout";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH, validatePassword } from "@/domain/user";
import { blurThenChange, formErrors } from "@/lib/form";
import { pageSeo } from "@/lib/seo";
import { resetPassword } from "@/server/password";

export const Route = createFileRoute("/redefinir-senha")({
  // The token arrives in the address, because that is what a mailed link can
  // carry. It is read here and sent in a body from then on.
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search["token"] === "string" ? search["token"] : "",
  }),
  head: () =>
    pageSeo({
      title: "Definir nova senha | Imobiliary",
      description: "Defina uma nova senha para sua conta.",
      path: "/redefinir-senha",
      noindex: true,
    }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);

  const form = useForm({
    defaultValues: { password: "" },
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) => formErrors([validatePassword(value.password)].filter((problem) => problem !== null)),
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await resetPassword({ data: { token, password: value.password } });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      await router.navigate({ to: "/entrar" });
    },
  });

  if (token === "") {
    return (
      <AuthLayout
        title="Link incompleto"
        subtitle="O endereço não traz o código do link. Peça um novo e abra-o direto do e-mail."
        footer={
          <Link to="/esqueci-senha" className="underline">
            Pedir outro link
          </Link>
        }
      >
        <div />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Definir nova senha"
      subtitle="Escolha uma senha nova para sua conta."
      summary={summaryOf(failure, {
        // A spent or expired link answers 401, the same as a wrong password
        // elsewhere. Here it can only mean the link.
        authentication: "Este link expirou ou já foi usado. Peça um novo.",
      })}
      footer={
        <>
          Ao definir a nova senha, as outras sessões da sua conta são encerradas.{" "}
          <Link to="/esqueci-senha" className="underline">
            Pedir outro link
          </Link>
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
        <form.Field name="password">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={form.state.submissionAttempts > 0}
              label="Nova senha"
              type="password"
              autoComplete="new-password"
              autoFocus
              hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
            />
          )}
        </form.Field>

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting} className="self-start">
              {isSubmitting ? "Salvando..." : "Definir senha"}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthLayout>
  );
}
