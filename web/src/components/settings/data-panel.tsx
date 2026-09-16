import { useState } from "react";
import { IconAlertCircle, IconDownload, IconTrash } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure } from "@/application/result";
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
import { saveFile } from "@/lib/download";
import { deleteAccount, exportAccount } from "@/server/privacy";

/**
 * Meus dados: the copy and the erasure the LGPD gives the account holder
 * (art. 18, II and VI).
 *
 * Both are about the account only. The people and contracts an office
 * registers belong to the office, and the policy says so.
 */
export function DataPanel() {
  return (
    <div className="flex flex-col gap-4">
      <ExportSection />
      <DeleteSection />
    </div>
  );
}

function ExportSection() {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onExport() {
    setPending(true);
    setFailure(null);
    try {
      const result = await exportAccount();
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      saveFile(
        result.value.filename,
        "application/json",
        new TextEncoder().encode(result.value.content),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-labelledby="export-title"
      className="flex max-w-2xl flex-col items-start gap-3 rounded-lg border border-border bg-card px-5 py-4"
    >
      <h2 id="export-title" className="text-sm font-semibold">
        Baixar meus dados
      </h2>
      <p className="font-reading text-small leading-relaxed text-muted-foreground">
        Um arquivo JSON com o que guardamos sobre a sua conta: cadastro, escritórios de que você
        participa, sessões, convites recebidos, as ações suas registradas na trilha de auditoria e
        os registros de acesso. Senhas, chaves e códigos de recuperação não entram no arquivo.
      </p>

      {failure !== null && (
        <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive-soft">
          <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{summaryOf(failure)}</span>
        </p>
      )}

      <Button type="button" size="sm" disabled={pending} onClick={onExport}>
        <IconDownload data-icon="inline-start" aria-hidden="true" />
        {pending ? "Preparando..." : "Baixar meus dados"}
      </Button>
    </section>
  );
}

function DeleteSection() {
  const [open, setOpen] = useState(false);
  // Mounted only once asked for: a Base UI dialog cannot be rendered on the
  // server here.
  const [mounted, setMounted] = useState(false);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  function ask() {
    setPassword("");
    setFailure(null);
    setMounted(true);
    setOpen(true);
  }

  async function onConfirm() {
    setPending(true);
    setFailure(null);
    try {
      const result = await deleteAccount({ data: password });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      // A full navigation: the cookie is gone, and everything the router has
      // cached belongs to an account that no longer exists.
      window.location.assign("/");
    } finally {
      setPending(false);
    }
  }

  const officeProblem = messageFor(failure, "organizations");
  const summary =
    officeProblem ??
    summaryOf(failure, { authentication: "Senha incorreta." });

  return (
    <section
      aria-labelledby="delete-title"
      className="flex max-w-2xl flex-col items-start gap-3 rounded-lg border border-destructive/35 bg-destructive/5 px-5 py-4"
    >
      <h2 id="delete-title" className="text-sm font-semibold">
        Excluir minha conta
      </h2>
      <p className="font-reading text-small leading-relaxed text-muted-foreground">
        Apaga sua conta, suas sessões e a verificação em duas etapas. Se você for o único membro de
        um escritório, ele é apagado junto. Se for o único administrador de um escritório que tem
        outros membros, torne outra pessoa administradora antes.
      </p>
      <p className="font-reading text-small leading-relaxed text-muted-foreground">
        Por seis meses, como exige o Marco Civil da Internet, guardamos os registros de acesso e o
        e-mail da conta, cifrado, para identificá-los. Depois disso são apagados. A trilha de
        auditoria do escritório continua mostrando o que foi feito, sem apontar para você.
      </p>
      <p className="text-caption text-faint">Se quiser levar seus dados, baixe-os antes.</p>

      <Button type="button" size="sm" variant="destructive" onClick={ask}>
        <IconTrash data-icon="inline-start" aria-hidden="true" />
        Excluir minha conta
      </Button>

      {mounted && (
        <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <AlertDialogContent>
            <form
              noValidate
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void onConfirm();
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>Excluir sua conta?</AlertDialogTitle>
                <AlertDialogDescription>
                  A exclusão é imediata e não pode ser desfeita. Confirme com a sua senha.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <FormField
                name="password"
                label="Sua senha"
                type="password"
                autoComplete="current-password"
                value={password}
                error={messageFor(failure, "password")}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setPassword(next);
                }}
              />

              {summary !== null && messageFor(failure, "password") === undefined && (
                <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive-soft">
                  <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                  <span>{summary}</span>
                </p>
              )}

              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
                <AlertDialogAction type="submit" variant="destructive" disabled={pending || password === ""}>
                  <IconTrash data-icon="inline-start" aria-hidden="true" />
                  {pending ? "Excluindo..." : "Excluir definitivamente"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  );
}
