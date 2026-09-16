import { useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH, validatePassword } from "@/domain/user";
import { blurThenChange, formErrors } from "@/lib/form";
import { changePassword } from "@/server/password";

const EMPTY = { current_password: "", new_password: "" };

/**
 * Changing the password, in the Segurança tab.
 *
 * The API ends every session of the account on a change, this one included,
 * and there is no way to keep the current one: an access token minted before
 * the change is refused from that moment. So the screen says so before, and
 * sends the person to sign in after, which is what actually happened.
 */
export function PasswordPanel() {
  const [failure, setFailure] = useState<Failure | null>(null);

  const form = useForm({
    defaultValues: EMPTY,
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) =>
        formErrors(
          [
            value.current_password === ""
              ? { field: "current_password", message: "Informe sua senha atual." }
              : null,
            validatePassword(value.new_password, "new_password"),
          ].filter((problem) => problem !== null),
        ),
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await changePassword({
        data: { currentPassword: value.current_password, newPassword: value.new_password },
      });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      // A full navigation: the cookie is gone and every cached loader result
      // belongs to the session that just ended.
      window.location.assign("/entrar");
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);

  return (
    <section
      aria-labelledby="password-title"
      className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4"
    >
      <h2 id="password-title" className="text-sm font-semibold">
        Alterar senha
      </h2>
      <p className="font-reading text-small leading-relaxed text-muted-foreground">
        Trocar a senha encerra todas as sessões da sua conta, inclusive esta. Você entra de novo
        com a senha nova em seguida.
      </p>

      {summaryOf(failure, {
        authentication: "A senha atual não confere.",
      }) !== null && (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(failure, { authentication: "A senha atual não confere." })}
        </p>
      )}

      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="current_password">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              label="Senha atual"
              type="password"
              autoComplete="current-password"
              serverError={messageFor(failure, "current_password")}
            />
          )}
        </form.Field>

        <form.Field name="new_password">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              label="Nova senha"
              type="password"
              autoComplete="new-password"
              hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
              serverError={messageFor(failure, "new_password")}
            />
          )}
        </form.Field>

        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Alterando..." : "Alterar senha"}
        </Button>
      </form>
    </section>
  );
}
