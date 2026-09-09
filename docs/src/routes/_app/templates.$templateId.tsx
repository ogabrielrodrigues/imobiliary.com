import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { cn } from "cn";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { DocumentPreview } from "@/components/document-preview";
import { FormField } from "@/components/form-field";
import {
  DocxIcon,
  LoadFailure,
  PageBody,
  PageHeader,
  StatusPill,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { placeholdersOf, type Block } from "@/domain/block";
import { countFilled, suggestFilename } from "@/domain/document";
import type { GeneratedDocument } from "@/domain/document";
import { groupPlaceholders, placeholderSyntax } from "@/domain/placeholder";
import { formatBytes, type Template } from "@/domain/template";
import { saveFile } from "@/lib/download";
import { relativeDate } from "@/lib/format";
import { downloadDocument, generateDocument } from "@/server/documents";
import { getTemplateContent } from "@/server/templates";

export const Route = createFileRoute("/_app/templates/$templateId")({
  loader: ({ params }) => getTemplateContent({ data: params.templateId }),
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

  return (
    <GenerateScreen
      template={result.value.template}
      blocks={result.value.blocks}
      previewUnavailable={result.value.previewUnavailable}
    />
  );
}

function GenerateScreen({
  template,
  blocks,
  previewUnavailable,
}: {
  readonly template: Template;
  readonly blocks: readonly Block[];
  readonly previewUnavailable: boolean;
}) {
  // The schema the API published is the authority on what must be sent; the
  // preview's own reading only decides where the fields sit on the page.
  const placeholders = template.version?.placeholders ?? placeholdersOf(blocks);

  const [values, setValues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<GeneratedDocument | null>(null);

  const filled = countFilled(placeholders, values);
  const missing = new Set(
    placeholders.filter((name) => (values[name] ?? "").trim() === ""),
  );

  function setValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  async function onGenerate() {
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

  // Placeholders the API objected to, so the document can mark them where they
  // sit rather than only listing them above the fold.
  const invalidFields = new Set(
    failure?.kind === "validation"
      ? failure.fields
          .map((f) => f.field)
          .filter((f) => f.startsWith("data."))
          .map((f) => f.slice("data.".length))
      : [],
  );

  return (
    <>
      <PageHeader
        title={template.name}
        actions={
          <>
            <Link
              to="/templates"
              className="rounded-md px-3 py-2 text-[13px] text-muted-foreground hover:text-foreground"
            >
              Voltar
            </Link>
            <Button type="button" disabled={pending} onClick={onGenerate}>
              {pending ? "Gerando…" : "Gerar documento"}
            </Button>
          </>
        }
      />

      <PageBody>
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
          <DocxIcon size={28} />
          <span>Versão {template.latestVersion}</span>
          <Dot />
          <span>Atualizado {relativeDate(template.updatedAt)}</span>
          {template.version && (
            <>
              <Dot />
              <span className="font-mono text-[12px]">
                {formatBytes(template.version.size)}
              </span>
            </>
          )}
        </div>

        {summary != null && (
          <p
            role="alert"
            className="max-w-3xl rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-[13px] text-destructive"
          >
            {summary}
          </p>
        )}

        {generated && (
          <GeneratedCard
            document={generated}
            saving={saving}
            onDownload={onDownload}
            onDismiss={() => setGenerated(null)}
          />
        )}

        <div className="grid max-w-5xl gap-5">
          {previewUnavailable ? (
            <FallbackForm
              placeholders={placeholders}
              values={values}
              onChange={setValue}
              failure={failure}
            />
          ) : (
            <>
              <p className="text-[12.5px] text-faint">
                Clique em um campo no documento para preenchê-lo. Esta é uma
                leitura simplificada do modelo — o arquivo gerado mantém a
                formatação original do Word.
              </p>
              <DocumentPreview
                blocks={blocks}
                values={values}
                onChange={setValue}
                invalid={invalidFields}
              />
            </>
          )}

          <Checklist
            placeholders={placeholders}
            filled={filled}
            missing={missing}
          />
        </div>
      </PageBody>
    </>
  );
}

function Dot() {
  return (
    <span aria-hidden="true" className="text-border-strong">
      ·
    </span>
  );
}

/**
 * The field panel, collapsed by default.
 *
 * A `<details>` rather than state and a toggle: the browser already knows how
 * to open and close one, and it works before any JavaScript loads.
 */
function Checklist({
  placeholders,
  filled,
  missing,
}: {
  readonly placeholders: readonly string[];
  readonly filled: number;
  readonly missing: ReadonlySet<string>;
}) {
  if (placeholders.length === 0) return null;

  return (
    <details className="rounded-lg border border-border bg-card px-5 py-4">
      <summary className="cursor-pointer text-[13px] font-medium text-muted-foreground marker:text-faint">
        Campos ·{" "}
        <span aria-live="polite" className="text-foreground">
          {filled} de {placeholders.length} preenchidos
        </span>
      </summary>

      <div className="mt-4 flex flex-col gap-4">
        {groupPlaceholders(placeholders).map((group) => (
          <section key={group.key ?? "__loose"} className="flex flex-col gap-2">
            {group.label !== null && (
              <h3 className="font-mono text-[11px] font-medium tracking-[0.1em] text-faint uppercase">
                {group.label}
              </h3>
            )}
            <ul className="flex flex-wrap gap-2">
              {group.fields.map((field) => (
                <li key={field.name}>
                  <span
                    className={cn(
                      "inline-block rounded-md border px-2 py-1 font-mono text-xs",
                      missing.has(field.name)
                        ? "border-docs/40 bg-docs/12 text-docs"
                        : "border-success/40 bg-success/12 text-success",
                    )}
                  >
                    {placeholderSyntax(field.name)}
                    {missing.has(field.name) ? "" : " ✓"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}

/**
 * The plain form, shown when the document could not be read.
 *
 * Generation never depended on the preview — the API renders from the original
 * archive — so a template this reader cannot make sense of stays perfectly
 * usable.
 */
function FallbackForm({
  placeholders,
  values,
  onChange,
  failure,
}: {
  readonly placeholders: readonly string[];
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (name: string, value: string) => void;
  readonly failure: Failure | null;
}) {
  if (placeholders.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Este modelo não declara nenhum campo, então não há o que preencher.
      </p>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <p className="text-[12.5px] text-faint">
        Não foi possível exibir o conteúdo deste modelo, então os campos vêm
        listados. A geração funciona normalmente.
      </p>

      {groupPlaceholders(placeholders).map((group) => (
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
                const value = event.currentTarget.value;
                onChange(field.name, value);
              }}
              error={messageFor(failure, `data.${field.name}`)}
            />
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function GeneratedCard({
  document,
  saving,
  onDownload,
  onDismiss,
}: {
  readonly document: GeneratedDocument;
  readonly saving: boolean;
  readonly onDownload: (document: GeneratedDocument) => void;
  readonly onDismiss: () => void;
}) {
  return (
    <section
      aria-label="Documento gerado"
      className="flex max-w-3xl flex-wrap items-center gap-3 rounded-lg border border-success/35 bg-success/8 px-5 py-4"
    >
      <DocxIcon size={30} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold">{document.filename}</span>
        <span className="text-xs text-faint">
          {formatBytes(document.size)} · versão {document.templateVersion}
        </span>
      </div>
      <StatusPill tone="success">Pronto</StatusPill>

      <div className="ml-auto flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={() => onDownload(document)}
        >
          {saving ? "Preparando…" : "Baixar"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          Fechar
        </Button>
      </div>
    </section>
  );
}
