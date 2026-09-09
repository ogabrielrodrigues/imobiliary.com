import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { Dropzone } from "@/components/dropzone";
import { FormField } from "@/components/form-field";
import { PlaceholderChips } from "@/components/placeholder-chips";
import { PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { validateTemplateFile } from "@/domain/template";
import type { Template } from "@/domain/template";
import { createTemplate } from "@/server/templates";

export const Route = createFileRoute("/_app/templates/novo")({
  head: () => ({ meta: [{ title: "Enviar modelo — Imobiliary Docs" }] }),
  component: NewTemplatePage,
});

function NewTemplatePage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<Template | null>(null);

  function onPick(chosen: File | null) {
    setFile(chosen);
    setFailure(null);

    // Checking here spares the round trip for the obvious mistakes — the wrong
    // extension, an empty file, one over the limit.
    if (chosen) {
      const problems = validateTemplateFile(chosen);
      if (problems.length > 0) {
        setFailure({ kind: "validation", fields: problems });
      }
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (file === null) {
      setFailure({
        kind: "validation",
        fields: [{ field: "file", message: "Escolha um arquivo .docx." }],
      });
      return;
    }

    const form = new FormData(event.currentTarget);
    // The input lives inside the dropzone's label and may hold a stale pick if
    // the file arrived by drag; the state is what the user actually chose.
    form.set("file", file, file.name);

    setPending(true);
    setFailure(null);

    try {
      const result = await createTemplate({ data: form });
      if (result.ok) {
        setCreated(result.value);
        return;
      }
      setFailure(result.failure);
    } finally {
      setPending(false);
    }
  }

  if (created) {
    return (
      <>
        <PageHeader title="Modelo enviado" />
        <PageBody>
          <div className="flex max-w-2xl flex-col gap-5 rounded-lg border border-border bg-card p-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-semibold">{created.name}</h2>
              <p className="text-[13px] text-muted-foreground">
                Versão {created.latestVersion} publicada. Estes são os campos
                que encontramos no documento — são exatamente os que você
                preencherá ao gerar.
              </p>
            </div>

            <PlaceholderChips names={created.version?.placeholders ?? []} />

            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => navigate({ to: "/templates" })}
              >
                Ver meus modelos
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCreated(null);
                  setFile(null);
                }}
              >
                Enviar outro
              </Button>
            </div>
          </div>
        </PageBody>
      </>
    );
  }

  const summary = summaryOf(failure);

  return (
    <>
      <PageHeader
        title="Enviar modelo"
        actions={
          <Link
            to="/templates"
            className="rounded-md px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground"
          >
            Cancelar
          </Link>
        }
      />
      <PageBody>
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex max-w-2xl flex-col gap-5"
        >
          {summary != null && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
            >
              {summary}
            </p>
          )}

          <Dropzone
            file={file}
            onSelect={onPick}
            error={messageFor(failure, "file")}
          />

          <FormField
            name="name"
            label="Nome do modelo"
            placeholder="Contrato de locação residencial"
            error={messageFor(failure, "name")}
          />
          <FormField
            name="description"
            label="Descrição"
            placeholder="Opcional"
            error={messageFor(failure, "description")}
          />

          <p className="text-[12.5px] leading-relaxed text-faint">
            Marque os campos no Word com{" "}
            <code className="font-mono text-docs">{"{{.nome_do_campo}}"}</code>,
            em minúsculas e sem acentos. Não importa se o Word quebrou o campo
            ao meio enquanto você digitava — nós remontamos.
          </p>

          <Button
            type="submit"
            disabled={pending}
            className="self-start"
          >
            {pending ? "Enviando…" : "Enviar modelo"}
          </Button>
        </form>
      </PageBody>
    </>
  );
}
