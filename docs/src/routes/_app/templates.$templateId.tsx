import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import {
  DocxIcon,
  LoadFailure,
  PageBody,
  PageHeader,
  StatusPill,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { countFilled, suggestFilename } from "@/domain/document";
import { groupPlaceholders, placeholderSyntax } from "@/domain/placeholder";
import { formatBytes, type Template } from "@/domain/template";
import type { GeneratedDocument } from "@/domain/document";
import { relativeDate } from "@/lib/format";
import { saveFile } from "@/lib/download";
import { downloadDocument, generateDocument } from "@/server/documents";
import { getTemplate } from "@/server/templates";

export const Route = createFileRoute("/_app/templates/$templateId")({
  loader: ({ params }) => getTemplate({ data: params.templateId }),
  head: () => ({ meta: [{ title: "Gerar documento — Imobiliary Docs" }] }),
  component: TemplateDetailPage,
});

function TemplateDetailPage() {
  const result = Route.useLoaderData();

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Modelo" />
        <PageBody>
          <LoadFailure failure={result.failure} />
        </PageBody>
      </>
    );
  }

  return <GenerateForm template={result.value} />;
}

function GenerateForm({ template }: { readonly template: Template }) {
  const placeholders = template.version?.placeholders ?? [];

  const [values, setValues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<GeneratedDocument | null>(null);

  const filled = countFilled(placeholders, values);
  const groups = groupPlaceholders(placeholders);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(null);

    try {
      const result = await generateDocument({
        data: {
          templateId: template.id,
          filename: suggestFilename(template.name),
          data: values,
          placeholders,
        },
      });

      if (result.ok) {
        setGenerated(result.value);
        return;
      }
      setFailure(result.failure);
    } finally {
      setPending(false);
    }
  }

  async function onDownload(document: GeneratedDocument) {
    setSaving(true);
    try {
      const result = await downloadDocument({ data: document.id });
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
      setSaving(false);
    }
  }

  const summary = summaryOf(failure);

  return (
    <>
      <PageHeader
        title={template.name}
        actions={
          <Link
            to="/templates"
            className="rounded-md px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground"
          >
            Voltar
          </Link>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
          <DocxIcon size={28} />
          <span>Versão {template.latestVersion}</span>
          <span aria-hidden="true" className="text-border-strong">
            ·
          </span>
          <span>Atualizado {relativeDate(template.updatedAt)}</span>
          {template.version && (
            <>
              <span aria-hidden="true" className="text-border-strong">
                ·
              </span>
              <span className="font-mono text-[12px]">
                {formatBytes(template.version.size)}
              </span>
            </>
          )}
        </div>

        {generated ? (
          <section
            aria-labelledby="generated-title"
            className="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-card p-6"
          >
            <div className="flex items-start gap-3">
              <DocxIcon />
              <div className="flex min-w-0 flex-col gap-0.5">
                <h2 id="generated-title" className="text-sm font-semibold">
                  {generated.filename}
                </h2>
                <p className="text-xs text-faint">
                  {formatBytes(generated.size)} · versão{" "}
                  {generated.templateVersion}
                </p>
              </div>
              <span className="ml-auto">
                <StatusPill tone="success">Pronto</StatusPill>
              </span>
            </div>

            {summary != null && (
              <p role="alert" className="text-[13px] text-destructive">
                {summary}
              </p>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                disabled={saving}
                onClick={() => onDownload(generated)}
              >
                {saving ? "Preparando…" : "Baixar documento"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setGenerated(null)}
              >
                Gerar outro
              </Button>
            </div>
          </section>
        ) : (
          <form onSubmit={onSubmit} noValidate className="flex max-w-2xl flex-col gap-6">
            {summary != null && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
              >
                {summary}
              </p>
            )}

            {placeholders.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                Este modelo não declara nenhum campo, então não há o que
                preencher.
              </p>
            ) : (
              <>
                <p
                  aria-live="polite"
                  className="font-mono text-[11px] tracking-[0.08em] text-faint uppercase"
                >
                  {filled} de {placeholders.length} preenchidos
                </p>

                {groups.map((group) => (
                  <fieldset
                    key={group.key ?? "__loose"}
                    className="flex flex-col gap-4 border-0 p-0"
                  >
                    {group.label !== null && (
                      <legend className="font-mono text-[11px] font-medium tracking-[0.1em] text-faint uppercase">
                        {group.label}
                      </legend>
                    )}
                    {group.fields.map((field) => (
                      <FormField
                        key={field.name}
                        name={field.name}
                        label={field.label}
                        placeholder={placeholderSyntax(field.name)}
                        value={values[field.name] ?? ""}
                        onChange={(event) => {
                          // Read before the updater runs: React nulls
                          // currentTarget once the handler returns.
                          const value = event.currentTarget.value;
                          setValues((current) => ({
                            ...current,
                            [field.name]: value,
                          }));
                        }}
                        error={messageFor(failure, `data.${field.name}`)}
                      />
                    ))}
                  </fieldset>
                ))}
              </>
            )}

            <Button type="submit" disabled={pending} className="self-start">
              {pending ? "Gerando…" : "Gerar documento"}
            </Button>
          </form>
        )}
      </PageBody>
    </>
  );
}
