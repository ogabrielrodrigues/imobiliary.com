import { createFileRoute } from "@tanstack/react-router";

import {
  EmptyState,
  LoadFailure,
  PageBody,
  PageHeader,
  StatusPill,
} from "@/components/page";
import { formatBytes } from "@/domain/template";
import { shortDateTime } from "@/lib/format";
import { listDocuments } from "@/server/documents";

export const Route = createFileRoute("/_app/documentos")({
  head: () => ({ meta: [{ title: "Documentos — Imobiliary Docs" }] }),
  loader: () => listDocuments(),
  component: DocumentsPage,
});

function DocumentsPage() {
  const result = Route.useLoaderData();

  return (
    <>
      <PageHeader title="Documentos" />
      <PageBody>
        {!result.ok ? (
          <LoadFailure failure={result.failure} />
        ) : result.value.length === 0 ? (
          <EmptyState
            title="Nenhum documento gerado"
            description="Abra um template e preencha os campos para gerar seu primeiro documento."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-raised">
                  {["Documento", "Versão", "Tamanho", "Gerado em", "Status"].map(
                    (heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="px-5 py-3 font-mono text-[11px] font-medium tracking-[0.08em] whitespace-nowrap text-faint uppercase"
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {result.value.map((document) => (
                  <tr
                    key={document.id}
                    className="border-b border-muted transition-colors last:border-b-0 hover:bg-row-hover"
                  >
                    <td className="px-5 py-3.5 text-[13.5px]">
                      {document.filename}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-[12.5px] text-muted-foreground">
                      v{document.templateVersion}
                    </td>
                    <td className="px-5 py-3.5 font-mono text-[12.5px] tabular-nums text-muted-foreground">
                      {formatBytes(document.size)}
                    </td>
                    <td className="px-5 py-3.5 text-[13px] whitespace-nowrap text-muted-foreground">
                      {shortDateTime(document.createdAt)}
                    </td>
                    <td className="px-5 py-3.5">
                      {/*
                        Always ready: generation is synchronous, so a row only
                        exists once the document does. There is no pending or
                        failed state to render.
                      */}
                      <StatusPill tone="success">Pronto</StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>
    </>
  );
}
