import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";

import { summaryOf, type Failure } from "@/application/result";
import { AuthLayout } from "@/components/auth-layout";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH, validateName, validatePassword } from "@/domain/user";
import { blurThenChange, formErrors, visibleError } from "@/lib/form";
import { pageSeo } from "@/lib/seo";
import { acceptInvitation, lookupInvitation } from "@/server/organization";

export const Route = createFileRoute("/convite")({
  validateSearch: (search: Record<string, unknown>): { token: string } => ({
    token: typeof search["token"] === "string" ? search["token"] : "",
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  // Read in the loader so the screen already knows which office is inviting
  // whom, and whether the person needs to choose a password at all.
  loader: async ({ deps }) =>
    deps.token === "" ? null : await lookupInvitation({ data: deps.token }),
  head: () =>
    pageSeo({
      title: "Convite | Imobiliary",
      description: "Aceite o convite para entrar em um escritório no Imobiliary.",
      path: "/convite",
      noindex: true,
    }),
  component: InvitationPage,
});

function InvitationPage() {
  const { token } = Route.useSearch();
  const invitation = Route.useLoaderData();
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);

  if (invitation === null || !invitation.ok) {
    return (
      <AuthLayout
        title="Convite inválido"
        subtitle="Este convite não existe mais: ele pode ter expirado, sido cancelado ou já aceito."
        footer={
          <>
            Se você já faz parte do escritório, é só{" "}
            <Link to="/entrar" className="underline">
              entrar
            </Link>
            .
          </>
        }
      >
        <div />
      </AuthLayout>
    );
  }

  const pending = invitation.value;
  const accountExists = pending.accountExists;

  return accountExists ? (
    <ExistingAccount token={token} organizationName={pending.organization.name} email={pending.email} />
  ) : (
    <NewAccount
      token={token}
      organizationName={pending.organization.name}
      email={pending.email}
      failure={failure}
      onFailure={setFailure}
      onAccepted={() => router.navigate({ to: "/entrar" })}
    />
  );
}

/** Someone who already has an account only has to say yes. */
function ExistingAccount({
  token,
  organizationName,
  email,
}: {
  readonly token: string;
  readonly organizationName: string;
  readonly email: string;
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [working, setWorking] = useState(false);

  return (
    <AuthLayout
      title={`Entrar no ${organizationName}`}
      subtitle={`O convite é para ${email}, que já tem conta no Imobiliary.`}
      summary={summaryOf(failure, {
        authentication: "Este convite expirou ou já foi usado.",
      })}
      footer="Depois de aceitar, entre com a senha que você já usa."
    >
      <Button
        disabled={working}
        onClick={async () => {
          setWorking(true);
          setFailure(null);
          const result = await acceptInvitation({
            data: { token, name: "", password: "", acceptedTerms: false, accountExists: true },
          });
          setWorking(false);
          if (!result.ok) {
            setFailure(result.failure);
            return;
          }
          await router.navigate({ to: "/entrar" });
        }}
        className="self-start"
      >
        {working ? "Aceitando..." : "Aceitar convite"}
      </Button>
    </AuthLayout>
  );
}

/** Someone new chooses a name and a password here, and joins in one step. */
function NewAccount({
  token,
  organizationName,
  email,
  failure,
  onFailure,
  onAccepted,
}: {
  readonly token: string;
  readonly organizationName: string;
  readonly email: string;
  readonly failure: Failure | null;
  readonly onFailure: (failure: Failure | null) => void;
  readonly onAccepted: () => Promise<unknown>;
}) {
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
    defaultValues: { name: "", password: "", terms: false },
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) =>
        formErrors(
          [
            validateName(value.name),
            validatePassword(value.password),
            value.terms ? null : { field: "terms", message: "É preciso aceitar os termos." },
          ].filter((problem) => problem !== null),
        ),
    },
    onSubmit: async ({ value }) => {
      onFailure(null);
      const result = await acceptInvitation({
        data: {
          token,
          name: value.name,
          password: value.password,
          acceptedTerms: value.terms,
          accountExists: false,
        },
      });
      if (!result.ok) {
        onFailure(result.failure);
        return;
      }
      await onAccepted();
    },
  });

  const submitted = attempted || form.state.submissionAttempts > 0;

  return (
    <AuthLayout
      title={`Entrar no ${organizationName}`}
      subtitle={`Crie sua conta para ${email} e comece a trabalhar no escritório.`}
      summary={summaryOf(failure, {
        authentication: "Este convite expirou ou já foi usado.",
      })}
      footer="Depois de criar a conta, entre com o e-mail do convite e a senha que você escolher."
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
        <form.Field name="name">
          {(field) => (
            <BoundFormField field={field} submitted={submitted} label="Seu nome" autoComplete="name" autoFocus />
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

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" disabled={isSubmitting} className="self-start">
              {isSubmitting ? "Criando..." : "Criar conta e entrar no escritório"}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </AuthLayout>
  );
}
