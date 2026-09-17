import { IconAlertCircle, IconDownload } from "@tabler/icons-react";
import { useState } from "react";

import { summaryOf, type Failure } from "@/application/result";
import { Button } from "@/components/ui/button";
import { saveFile } from "@/lib/download";
import { exportOffice } from "@/server/auth";

/** The office's copy of what the document service holds. Article 18, II and V. */
export function ExportPanel() {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onExport() {
    setPending(true);
    setFailure(null);

    try {
      const result = await exportOffice();
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
        Baixar os dados do escritório
      </h2>
      <p className="text-small leading-relaxed text-muted-foreground">
        Um arquivo com tudo o que guardamos aqui: o escritório, seus modelos,
        todas as versões, os lotes e todos os documentos gerados, incluindo os
        valores preenchidos em cada um. Modelos excluídos aparecem marcados como
        tal, porque continuam armazenados.
      </p>
      <p className="text-caption text-faint">
        Os arquivos .docx em si não vêm neste JSON; baixe-os em Modelos e em
        Documentos.
      </p>

      {failure && (
        <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive">
          <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{summaryOf(failure)}</span>
        </p>
      )}

      <Button type="button" size="sm" disabled={pending} onClick={onExport}>
        <IconDownload data-icon="inline-start" aria-hidden="true" />
        {pending ? "Preparando…" : "Baixar os dados do escritório"}
      </Button>
    </section>
  );
}
