import { IconAlertCircle, IconDownload, IconFiles } from "@tabler/icons-react";
import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { summaryOf, type Failure } from "@/application/result";
import type { DocumentListItem } from "@/application/views";
import {
  EmptyState,
  LoadFailure,
  PageBody,
  PageHeader,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/domain/template";
import { saveFile } from "@/lib/download";
import { shortDateTime } from "@/lib/format";
import { documentPageQuery } from "@/queries/options";
import { downloadDocument } from "@/server/documents";

export const Route = createFileRoute("/_app/documentos")({
  head: () => ({ meta: [{ title: "Documentos | Imobiliary Docs" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(documentPageQuery(0)),
  component: DocumentsPage,
});

function DocumentsPage() {
  const { data: page } = useSuspenseQuery(documentPageQuery(0));
  const result = page.ok ? { ok: true as const, value: page.value.items } : page;

  // Tracks which row is being fetched, so only that button says so.
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onDownload(id: string) {
    setSaving(id);
    setFailure(null);

    try {
      const downloaded = await downloadDocument({ data: id });
      if (downloaded.ok) {
        saveFile(
          downloaded.value.filename,
          downloaded.value.contentType,
          downloaded.value.bytes,
        );
        return;
      }
      setFailure(downloaded.failure);
    } finally {
      setSaving(null);
    }
  }

  const summary = summaryOf(failure);

  return (
    <>
      <PageHeader title="Documentos" />
      <PageBody>
        {summary != null && (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-small text-destructive-soft"
          >
            <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{summary}</span>
          </p>
        )}

        {!result.ok ? (
          <LoadFailure failure={result.failure} />
        ) : result.value.length === 0 ? (
          <EmptyState
            icon={<IconFiles />}
            title="Nenhum documento gerado"
            description="Abra um modelo e preencha os campos para gerar seu primeiro documento."
            action={
              <Button
                size="sm"
                nativeButton={false}
                render={<Link to="/templates" />}
              >
                Ver modelos
              </Button>
            }
          />
        ) : (
          <>
          {/*
            Below md the table becomes a list of cards: five columns do not fit
            a phone, and a table scrolled sideways hides the one button that
            matters. Only one of the two is ever displayed, so a screen reader
            meets the documents once.
          */}
          <ul
            aria-label="Documentos gerados, do mais recente ao mais antigo"
            className="flex flex-col gap-3 md:hidden"
          >
            {result.value.map((item) => (
              <DocumentCard
                key={item.document.id}
                item={item}
                saving={saving === item.document.id}
                onDownload={onDownload}
              />
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-lg border border-border bg-card md:block">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">
                Documentos gerados, do mais recente ao mais antigo
              </caption>
              <thead>
                <tr className="border-b border-border bg-raised">
                  {["Documento", "Modelo", "Gerado em", "Tamanho", ""].map(
                    (heading, index) => (
                      <th
                        key={heading || `actions-${index}`}
                        scope="col"
                        className="px-5 py-3 font-mono text-label font-medium tracking-[0.08em] whitespace-nowrap text-faint uppercase"
                      >
                        {heading === "" ? (
                          <span className="sr-only">Ações</span>
                        ) : (
                          heading
                        )}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {result.value.map((item) => (
                  <DocumentRow
                    key={item.document.id}
                    item={item}
                    saving={saving === item.document.id}
                    onDownload={onDownload}
                  />
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </PageBody>
    </>
  );
}

/** One document as a card, for screens too narrow for the table. */
function DocumentCard({
  item,
  saving,
  onDownload,
}: {
  readonly item: DocumentListItem;
  readonly saving: boolean;
  readonly onDownload: (id: string) => void;
}) {
  const { document, templateName } = item;

  return (
    <li className="flex flex-col gap-2.5 rounded-lg border border-border bg-card px-4 py-3.5">
      <span className="text-control font-medium break-all">{document.filename}</span>
      <span className="text-small text-muted-foreground">
        {templateName === null ? (
          <span className="text-faint italic">modelo indisponível</span>
        ) : (
          <Link
            to="/templates/$templateId"
            params={{ templateId: document.templateId }}
            className="hover:text-foreground hover:underline"
          >
            {templateName}
          </Link>
        )}
        <span className="ml-2 font-mono text-meta text-faint">
          v{document.templateVersion}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <time dateTime={document.createdAt.toISOString()}>
          {shortDateTime(document.createdAt)}
        </time>
        <span className="font-mono tabular-nums">{formatBytes(document.size)}</span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={saving}
        onClick={() => onDownload(document.id)}
        className="h-10 self-start"
      >
        <IconDownload data-icon="inline-start" aria-hidden="true" />
        {saving ? "Preparando…" : "Baixar"}
      </Button>
    </li>
  );
}

function DocumentRow({
  item,
  saving,
  onDownload,
}: {
  readonly item: DocumentListItem;
  readonly saving: boolean;
  readonly onDownload: (id: string) => void;
}) {
  const { document, templateName } = item;

  return (
    <tr className="border-b border-muted transition-colors last:border-b-0 hover:bg-row-hover">
      <td className="px-5 py-3.5 text-control">{document.filename}</td>

      <td className="px-5 py-3.5 text-small text-muted-foreground">
        {templateName === null ? (
          // The template was deleted, or sits beyond the page fetched to
          // resolve names. Saying so beats printing a bare identifier.
          <span className="text-faint italic">modelo indisponível</span>
        ) : (
          <Link
            to="/templates/$templateId"
            params={{ templateId: document.templateId }}
            className="hover:text-foreground hover:underline"
          >
            {templateName}
          </Link>
        )}
        <span className="ml-2 font-mono text-meta text-faint">
          v{document.templateVersion}
        </span>
      </td>

      <td className="px-5 py-3.5 text-small whitespace-nowrap text-muted-foreground">
        <time dateTime={document.createdAt.toISOString()}>
          {shortDateTime(document.createdAt)}
        </time>
      </td>

      <td className="px-5 py-3.5 font-mono text-caption tabular-nums whitespace-nowrap text-muted-foreground">
        {formatBytes(document.size)}
      </td>

      <td className="px-5 py-3.5 text-right whitespace-nowrap">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={saving}
          onClick={() => onDownload(document.id)}
        >
          <IconDownload data-icon="inline-start" aria-hidden="true" />
          {saving ? "Preparando…" : "Baixar"}
        </Button>
      </td>
    </tr>
  );
}
