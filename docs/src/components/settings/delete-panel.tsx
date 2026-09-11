import { IconAlertCircle, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ACCOUNT_DELETION_CONFIRMATION, deleteAccount } from "@/server/auth";

/** Erasure, article 18, VI. */
export function DeletePanel() {
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  // Mounted only once asked for: Base UI renders its root through a portal,
  // which does not survive hydration here.
  const [mounted, setMounted] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  function ask() {
    setConfirmation("");
    setFailure(null);
    setMounted(true);
    setOpen(true);
  }

  async function onConfirm() {
    setPending(true);
    setFailure(null);

    try {
      const result = await deleteAccount({ data: confirmation });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      // The session is already cleared server-side, so there is nothing to
      // sign out of — only somewhere to go.
      await navigate({ to: "/" });
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="delete-title"
      className="flex max-w-2xl flex-col items-start gap-3 rounded-lg border border-destructive/35 bg-destructive/5 px-5 py-4"
    >
      <h2 id="delete-title" className="text-sm font-semibold">
        Excluir minha conta
      </h2>
      <p className="text-small leading-relaxed text-muted-foreground">
        Apaga sua conta e tudo que pertence a ela: modelos, versões, documentos
        gerados, os valores preenchidos neles e os arquivos armazenados. A
        exclusão é imediata e definitiva: não há como desfazer, e nós não
        guardamos cópia.
      </p>
      <p className="text-caption text-faint">
        Se quiser levar seus dados, baixe-os antes.
      </p>

      <Button type="button" size="sm" variant="destructive" onClick={ask}>
        <IconTrash data-icon="inline-start" aria-hidden="true" />
        Excluir minha conta
      </Button>

      {mounted && (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Excluir sua conta?</AlertDialogTitle>
              <AlertDialogDescription>
                Tudo será apagado imediatamente e não poderá ser recuperado.
                Digite {ACCOUNT_DELETION_CONFIRMATION} para confirmar.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <FormField
              name="confirmation"
              label={`Digite ${ACCOUNT_DELETION_CONFIRMATION}`}
              autoComplete="off"
              value={confirmation}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setConfirmation(value);
              }}
              error={
                failure?.kind === "validation"
                  ? failure.fields.find((f) => f.field === "confirmation")
                      ?.message
                  : undefined
              }
            />

            {failure && failure.kind !== "validation" && (
              <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive">
                <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                <span>{summaryOf(failure)}</span>
              </p>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending || confirmation !== ACCOUNT_DELETION_CONFIRMATION}
                onClick={onConfirm}
              >
                <IconTrash data-icon="inline-start" aria-hidden="true" />
                {pending ? "Excluindo…" : "Excluir definitivamente"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  );
}
