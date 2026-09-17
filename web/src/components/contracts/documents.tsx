import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import {
  IconDownload,
  IconEye,
  IconFilePlus,
  IconTrash,
} from "@tabler/icons-react";

import type { Block } from "@imobiliary/docx/blocks";
import { DocumentPreview } from "@imobiliary/docx/preview";

import { summaryOf, type Failure } from "@/application/result";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GeneratedDocument } from "@/domain/document";
import { saveFile } from "@/lib/download";
import {
  deleteDocument,
  downloadDocument,
  readDocument,
} from "@/server/documents";

/** The day a document was generated, as the rest of the platform writes days. */
function formatMoment(at: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(at);
}

/**
 * The documents generated from this contract.
 *
 * They live in the document service, and this is the same list the Docs
 * platform shows in its history: one document, one place, read from both.
 */
export function ContractDocuments({
  contractId,
  documents,
  failure,
}: {
  readonly contractId: string;
  readonly documents: readonly GeneratedDocument[];
  readonly failure: Failure | null;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-title-sm font-semibold">Documentos</h2>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          nativeButton={false}
          render={
            <Link to="/contratos/$contractId/documento" params={{ contractId }} />
          }
        >
          <IconFilePlus data-icon="inline-start" aria-hidden="true" />
          Gerar documento
        </Button>
      </div>

      {failure !== null ? (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(failure, {
            authentication:
              "Não foi possível falar com o serviço de documentos. Entre novamente.",
          })}
        </p>
      ) : documents.length === 0 ? (
        <p className="text-small text-muted-foreground">
          Nenhum documento gerado a partir deste contrato.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
            >
              <span className="min-w-0 grow basis-full truncate text-small font-medium sm:basis-0">
                {document.filename.replace(/\.docx$/i, "")}
              </span>
              <span className="text-caption text-faint">
                {formatMoment(document.createdAt)}
              </span>
              <ViewDocument document={document} />
              <DownloadDocument document={document} />
              <DeleteDocument document={document} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Reads the document inside the platform, without leaving the contract. */
function ViewDocument({ document }: { readonly document: GeneratedDocument }) {
  const [open, setOpen] = useState(false);
  // Mounted only once asked for: a Base UI dialog cannot render on the server.
  const [mounted, setMounted] = useState(false);
  const [blocks, setBlocks] = useState<readonly Block[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);

  async function onOpen() {
    setMounted(true);
    setOpen(true);
    if (blocks !== null || pending) return;

    setPending(true);
    try {
      const result = await readDocument({ data: document.id });
      if (result.ok) setBlocks(result.value);
      else setFailure(result.failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Ver ${document.filename}`}
        onClick={() => void onOpen()}
      >
        <IconEye data-icon="inline-start" aria-hidden="true" />
        Ver
      </Button>

      {mounted && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{document.filename.replace(/\.docx$/i, "")}</DialogTitle>
              <DialogDescription>
                Leitura do documento gerado. O arquivo para imprimir ou assinar é
                o .docx, que você baixa aqui mesmo.
              </DialogDescription>
            </DialogHeader>

            {pending && <p className="text-small text-muted-foreground">Abrindo…</p>}
            {failure !== null && (
              <p role="alert" className="text-small text-destructive-soft">
                {summaryOf(failure)}
              </p>
            )}
            {blocks !== null && <DocumentPreview blocks={blocks} renderPlaceholder={plainValue} />}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/**
 * A generated document has no placeholders left, since every one of them was
 * replaced before the file was written. Should the reader still find one, it is
 * drawn as the text it is rather than as an editable field.
 */
function plainValue(name: string) {
  return <span>{`{{.${name}}}`}</span>;
}

function DownloadDocument({ document }: { readonly document: GeneratedDocument }) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onDownload() {
    setPending(true);
    setFailure(null);
    try {
      const result = await downloadDocument({ data: document.id });
      if (result.ok) {
        saveFile(result.value.filename, result.value.contentType, result.value.bytes);
        return;
      }
      setFailure(result.failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        aria-label={`Baixar ${document.filename}`}
        onClick={() => void onDownload()}
      >
        <IconDownload data-icon="inline-start" aria-hidden="true" />
        {pending ? "Baixando…" : "Baixar"}
      </Button>
      {failure !== null && (
        <span role="alert" className="text-caption text-destructive-soft">
          {summaryOf(failure)}
        </span>
      )}
    </>
  );
}

function DeleteDocument({ document }: { readonly document: GeneratedDocument }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onDelete() {
    setPending(true);
    setFailure(null);
    const result = await deleteDocument({ data: document.id });
    setPending(false);

    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setOpen(false);
    await router.invalidate();
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Excluir ${document.filename}`}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <IconTrash data-icon="inline-start" aria-hidden="true" />
        Excluir
      </Button>

      {mounted && (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Excluir este documento?</AlertDialogTitle>
              <AlertDialogDescription>
                O arquivo e os valores preenchidos são apagados. O contrato e os
                aluguéis não mudam, e você pode gerar o documento de novo.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {failure !== null && (
              <p role="alert" className="text-small text-destructive-soft">
                {summaryOf(failure)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                onClick={() => void onDelete()}
              >
                {pending ? "Excluindo…" : "Excluir"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
