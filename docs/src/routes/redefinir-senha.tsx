import { useEffect, useState } from "react";
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
import { MIN_PASSWORD_LENGTH, validateNewPassword } from "@/domain/user";
import { blurThenChange, formErrors } from "@/lib/form";
import { currentUser, resetPassword } from "@/server/auth";

/** The token arrives in the link the email carries. */
interface ResetSearch {
  readonly token?: string;
}

export const Route = createFileRoute("/redefinir-senha")({
  validateSearch: (search: Record<string, unknown>): ResetSearch => {
    const token = search["token"];
    return typeof token === "string" && token !== "" ? { token } : {};
  },
  beforeLoad: async () => {
    if ((await currentUser()) !== null) {
      throw redirect({ to: "/dashboard" });
    }
  },
  head: () => ({
    meta: [
      { title: "Redefinir senha | Imobiliary Docs" },
      // A page reached only from a private link has nothing to offer a
      // crawler, and its address carries a secret.
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();

  /*
   * The token is captured once and then taken out of the address.
   *
   * Captured first, and this is not optional: blanking the URL makes the router
   * re-read its search parameters, so a component still reading them would
   * watch the token vanish underneath it and decide the link was invalid.
   *
   * Removing it is worth doing anyway. Referrer-Policy already stops it
   * reaching another site, but it would otherwise sit in the browser's history
   * and in the address bar over someone's shoulder.
   */
  const [token] = useState(() => search.token);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (search.token !== undefined) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [search.token]);

  const form = useForm({
    defaultValues: { password: "" },
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) => formErrors(validateNewPassword(value.password)),
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await resetPassword({
        data: { token: token ?? "", password: value.password },
      });
      if (result.ok) {
        // No session is opened by a reset, so the next step is signing in with
        // what was just chosen.
        await navigate({ to: "/entrar" });
        return;
      }
      setFailure(result.failure);
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);

  if (token === undefined) {
    return (
      <AuthLayout
        title="Link inválido"
        subtitle="Este endereço não traz um token de redefinição."
        footer={
          <>
            Pode{" "}
            <Link to="/esqueci-senha" className="font-medium text-primary-text">
              pedir um novo link
            </Link>{" "}
            a qualquer momento.
          </>
        }
      >
        <p className="text-control leading-relaxed text-muted-foreground">
          Links de redefinição valem por 30 minutos e só funcionam uma vez. Se o
          seu expirou ou já foi usado, peça outro.
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Escolha uma nova senha"
      subtitle="Ao confirmar, todas as sessões abertas serão encerradas."
      summary={summaryOf(failure)}
      footer={
        <>
          O link expirou?{" "}
          <Link to="/esqueci-senha" className="font-medium text-primary-text">
            Pedir outro
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
        <form.Field name="password">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              serverError={messageFor(failure, "password")}
              onEdit={() => setFailure(null)}
              label="Nova senha"
              type="password"
              autoComplete="new-password"
              autoFocus
              hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
            />
          )}
        </form.Field>
        <Button type="submit" disabled={pending} className="mt-1">
          {pending ? "Salvando…" : "Salvar nova senha"}
        </Button>
      </form>
    </AuthLayout>
  );
}
