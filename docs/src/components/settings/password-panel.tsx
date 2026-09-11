import { IconAlertCircle, IconCircleCheck } from "@tabler/icons-react";
import { useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { BoundFormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH, validatePasswordChange } from "@/domain/user";
import { blurThenChange, formErrors } from "@/lib/form";
import { changePassword } from "@/server/auth";

const EMPTY = { currentPassword: "", newPassword: "" };

/** Changing the password, in the Segurança tab of Ajustes. */
export function PasswordPanel() {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [changed, setChanged] = useState(false);

  const form = useForm({
    defaultValues: EMPTY,
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) => formErrors(validatePasswordChange(value)),
    },
    onSubmit: async ({ value, formApi }) => {
      setFailure(null);
      setChanged(false);

      const result = await changePassword({ data: value });
      if (result.ok) {
        setChanged(true);
        // Back to a blank, untouched form: neither password should linger on
        // screen, and nothing about it should look like an error.
        formApi.reset();
        return;
      }
      setFailure(result.failure);
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);
  const onEdit = () => {
    setFailure(null);
    setChanged(false);
  };

  return (
    <section
      aria-labelledby="password-title"
      className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4"
    >
      <h2 id="password-title" className="text-sm font-semibold">
        Alterar senha
      </h2>
      <p className="text-small leading-relaxed text-muted-foreground">
        Ao trocar a senha, as sessões abertas em outros dispositivos são
        encerradas na hora. Esta continua conectada.
      </p>

      {changed && (
        <p role="status" className="flex items-start gap-1.5 text-caption text-success">
          <IconCircleCheck aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>Senha alterada. Enviamos um aviso para o seu e-mail.</span>
        </p>
      )}
      {failure && messageFor(failure, "currentPassword") === undefined &&
        messageFor(failure, "newPassword") === undefined && (
          <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive">
            <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span>{summaryOf(failure)}</span>
          </p>
        )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        noValidate
        className="flex flex-col gap-4"
      >
        <form.Field name="currentPassword">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              serverError={messageFor(failure, "currentPassword")}
              onEdit={onEdit}
              label="Senha atual"
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.Field>
        <form.Field name="newPassword">
          {(field) => (
            <BoundFormField
              field={field}
              submitted={submitted}
              serverError={messageFor(failure, "newPassword")}
              onEdit={onEdit}
              label="Nova senha"
              type="password"
              autoComplete="new-password"
              hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
            />
          )}
        </form.Field>
        <Button type="submit" size="sm" disabled={pending} className="self-start">
          {pending ? "Alterando…" : "Alterar senha"}
        </Button>
      </form>
    </section>
  );
}
