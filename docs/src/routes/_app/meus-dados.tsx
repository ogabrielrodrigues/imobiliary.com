import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import { PageBody, PageHeader } from "@/components/page";
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
import { CONTROLLER } from "@/domain/legal";
import { saveFile } from "@/lib/download";
import {
  ACCOUNT_DELETION_CONFIRMATION,
  deleteAccount,
  exportAccount,
} from "@/server/auth";

export const Route = createFileRoute("/_app/meus-dados")({
  head: () => ({ meta: [{ title: "Meus dados — Imobiliary Docs" }] }),
  component: PrivacySettingsPage,
});

/**
 * Where the rights of article 18 are actually exercised.
 *
 * A policy that describes rights and a support address that grants them is the
 * common arrangement and the weakest one: it makes the person ask permission
 * for something the law already gave them. Both operations here resolve in one
 * request, because the service holds nothing that needs a human to decide.
 */
function PrivacySettingsPage() {
  return (
    <>
      <PageHeader title="Meus dados" />
      <PageBody>
        <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
          A Lei n.º 13.709/2018 (LGPD) garante a você o direito de acessar,
          levar consigo e eliminar seus dados. As duas coisas abaixo são
          imediatas — não passam por pedido nem por análise. Os detalhes de o
          que guardamos estão na{" "}
          <Link to="/privacidade" className="text-primary hover:underline">
            Política de Privacidade
          </Link>
          .
        </p>

        <ExportPanel />
        <DeletePanel />

        <p className="max-w-2xl text-[12.5px] leading-relaxed text-faint">
          Para correção de dados, dúvidas ou qualquer outro pedido, escreva para{" "}
          {CONTROLLER.privacyEmail}. Encarregado pelo tratamento de dados:{" "}
          {CONTROLLER.officerName}, {CONTROLLER.officerEmail}.
        </p>
      </PageBody>
    </>
  );
}

/** Access and portability, article 18, II and V. */
function ExportPanel() {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onExport() {
    setPending(true);
    setFailure(null);

    try {
      const result = await exportAccount();
      if (result.ok) {
        saveFile(
          result.value.filename,
          result.value.contentType,
          result.value.bytes,
        );
        return;
      }
      setFailure(result.failure);
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
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Um arquivo com tudo o que guardamos: sua conta, seus modelos, todas as
        versões e todos os documentos gerados — incluindo os valores que você
        preencheu em cada um. Modelos que você excluiu aparecem marcados como
        tal, porque continuam armazenados até a exclusão da conta.
      </p>
      <p className="text-[12.5px] text-faint">
        Os arquivos .docx em si não vêm neste JSON; baixe-os em Modelos e em
        Documentos.
      </p>

      {failure && (
        <p role="alert" className="text-[12.5px] text-destructive">
          {summaryOf(failure)}
        </p>
      )}

      <Button type="button" size="sm" disabled={pending} onClick={onExport}>
        {pending ? "Preparando…" : "Baixar meus dados"}
      </Button>
    </section>
  );
}

/** Erasure, article 18, VI. */
function DeletePanel() {
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
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Apaga sua conta e tudo que pertence a ela: modelos, versões, documentos
        gerados, os valores preenchidos neles e os arquivos armazenados. A
        exclusão é imediata e definitiva — não há como desfazer, e nós não
        guardamos cópia.
      </p>
      <p className="text-[12.5px] text-faint">
        Se quiser levar seus dados, baixe-os antes.
      </p>

      <Button
        type="button"
        size="sm"
        variant="destructive"
        onClick={ask}
      >
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
              <p role="alert" className="text-[12.5px] text-destructive">
                {summaryOf(failure)}
              </p>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending || confirmation !== ACCOUNT_DELETION_CONFIRMATION}
                onClick={onConfirm}
              >
                {pending ? "Excluindo…" : "Excluir definitivamente"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  );
}
