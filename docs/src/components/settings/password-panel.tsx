import { useState, type FormEvent } from "react";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH } from "@/domain/user";
import { changePassword } from "@/server/auth";

/** Changing the password, in the Segurança tab of Ajustes. */
export function PasswordPanel() {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [changed, setChanged] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);

    setPending(true);
    setFailure(null);
    setChanged(false);

    try {
      const result = await changePassword({
        data: {
          currentPassword: String(values.get("currentPassword") ?? ""),
          newPassword: String(values.get("newPassword") ?? ""),
        },
      });
      if (result.ok) {
        setChanged(true);
        form.reset();
        return;
      }
      setFailure(result.failure);
    } finally {
      setPending(false);
    }
  }

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
        <p role="status" className="text-caption text-success">
          Senha alterada. Enviamos um aviso para o seu e-mail.
        </p>
      )}
      {failure && messageFor(failure, "currentPassword") === undefined &&
        messageFor(failure, "newPassword") === undefined && (
          <p role="alert" className="text-caption text-destructive">
            {summaryOf(failure)}
          </p>
        )}

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <FormField
          name="currentPassword"
          label="Senha atual"
          type="password"
          autoComplete="current-password"
          error={messageFor(failure, "currentPassword")}
        />
        <FormField
          name="newPassword"
          label="Nova senha"
          type="password"
          autoComplete="new-password"
          hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
          error={messageFor(failure, "newPassword")}
        />
        <Button type="submit" size="sm" disabled={pending} className="self-start">
          {pending ? "Alterando…" : "Alterar senha"}
        </Button>
      </form>
    </section>
  );
}
