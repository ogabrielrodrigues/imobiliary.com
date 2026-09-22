import { useEffect, useMemo, useState } from "react";
import { IconFileText } from "@tabler/icons-react";

import { DocumentPreview, PlaceholderField } from "@imobiliary/docx/preview";
import { humanize } from "@imobiliary/docx/placeholder";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  emptyPlaceholders,
  suggestDocumentName,
  unknownPlaceholders,
  type DocumentSubject,
  type Template,
} from "@/domain/document";
import { cn } from "@/lib/utils";
import { generateDocument, getDocumentDraft } from "@/server/documents";

/** "o contrato" becomes "no contrato"; "a locação", "na locação". */
function inThe(noun: string): string {
  return noun.startsWith("a ") ? `na ${noun.slice(2)}` : `no ${noun.slice(2)}`;
}

/*
  Generating a document from a record, a lease or a payout to an owner: the
  template first, then the review, where the office reads the document with
  the record's answers in place and changes anything before the file is
  written. A field the record cannot answer is shown empty, marked, and
  filled there.
*/

/** The office's templates, as they are kept in Imobiliary Docs. */
export function TemplateChoice({
  templates,
  onChoose,
}: {
  readonly templates: readonly Template[];
  readonly onChoose: (id: string) => void;
}) {
  if (templates.length === 0) {
    return (
      <p className="text-small text-muted-foreground">
        O escritório ainda não tem modelos. Envie um em Imobiliary Docs e ele
        aparece aqui.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-title-sm font-semibold">Escolha o modelo</h2>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {templates.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              onClick={() => onChoose(template.id)}
              className="flex w-full flex-wrap items-center gap-3 px-3 py-3 text-left hover:bg-row-hover"
            >
              <IconFileText aria-hidden="true" className="size-4 shrink-0 text-faint" />
              <span className="min-w-0 grow basis-full sm:basis-0">
                <span className="block truncate text-small font-medium">
                  {template.name}
                </span>
                {template.description !== "" && (
                  <span className="block truncate text-caption text-muted-foreground">
                    {template.description}
                  </span>
                )}
              </span>
              <span className="text-caption text-faint">
                versão {template.latestVersion}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The review: the document with the record's answers in place.
 *
 * The values live here, so the preview and the list of fields can never
 * disagree about what will be sent. What is sent is exactly what is on screen.
 */
export function Review({
  subject,
  templateId,
  record,
  person,
  noun,
  onBack,
  onGenerated,
}: {
  readonly subject: DocumentSubject;
  readonly templateId: string;
  /** The record's number, for the suggested name: "2026/001". */
  readonly record: string;
  /** Who the document concerns, for the suggested name: the tenant, the owner. */
  readonly person: string;
  /** How the screen names the record in a sentence: "o contrato", "o repasse". */
  readonly noun: string;
  readonly onBack: () => void;
  readonly onGenerated: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<
    Awaited<ReturnType<typeof getDocumentDraft>> | null
  >(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [filename, setFilename] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);

  // Loaded here rather than in the route's loader: the template is chosen on
  // this screen, and a loader would have to re-run the whole route to follow.
  useEffect(() => {
    let current = true;
    setLoading(true);
    void getDocumentDraft({ data: { subject, templateId } }).then((result) => {
      if (!current) return;
      setLoading(false);
      setDraft(result);
      if (!result.ok) return;

      const initial: Record<string, string> = {};
      for (const field of result.value.fields) initial[field.name] = field.value;
      setValues(initial);
      setFilename(
        suggestDocumentName({
          template: result.value.template.name,
          record,
          person,
        }),
      );
    });
    return () => {
      current = false;
    };
    // The subject is a new object on every render; its identity is its id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject.kind, subject.id, templateId, record, person]);

  const placeholders = draft?.ok ? draft.value.placeholders : [];
  const unknown = useMemo(
    () => (draft?.ok ? unknownPlaceholders(placeholders, draft.value.fields) : []),
    [draft, placeholders],
  );
  const missing = useMemo(
    () => emptyPlaceholders(placeholders, values),
    [placeholders, values],
  );

  async function onGenerate() {
    setPending(true);
    setFailure(null);
    const result = await generateDocument({
      data: { subject, templateId, filename, values },
    });
    setPending(false);

    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await onGenerated();
  }

  if (loading) {
    return <p className="text-small text-muted-foreground">Lendo o modelo…</p>;
  }
  if (draft === null || !draft.ok) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-destructive-soft">
          {draft === null
            ? "Não foi possível ler o modelo."
            : summaryOf(draft.failure, {
                not_found: "Este modelo não existe mais.",
              })}
        </p>
        <Button variant="secondary" size="sm" onClick={onBack}>
          Escolher outro modelo
        </Button>
      </div>
    );
  }

  const { template, blocks } = draft.value;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-title-sm font-semibold">{template.name}</h2>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onBack}>
          Trocar de modelo
        </Button>
      </div>

      <FormField
        name="filename"
        label="Nome do documento"
        hint={`É assim que ele aparece ${inThe(noun)} e no histórico do Imobiliary Docs.`}
        error={messageFor(failure, "filename")}
        value={filename}
        placeholder="Modelo - 2026/001 - Nome"
        onChange={(event) => setFilename(event.currentTarget.value)}
      />

      {unknown.length > 0 && (
        <p className="rounded-md border border-docs/35 bg-docs/5 px-3 py-2 text-small text-docs-soft">
          Este modelo pede {unknown.length === 1 ? "um campo" : `${unknown.length} campos`}{" "}
          que {noun} não responde: {unknown.map(humanize).join(", ")}. Preencha
          {unknown.length === 1 ? "-o" : "-os"} abaixo antes de gerar.
        </p>
      )}

      {blocks === null ? (
        <p className="text-small text-muted-foreground">
          A prévia deste modelo não pôde ser montada, então os campos aparecem em
          lista. O documento gerado sai do arquivo original, com a formatação
          intacta.
        </p>
      ) : (
        <DocumentPreview
          blocks={blocks}
          renderPlaceholder={(name, marks, editing) => (
            <PlaceholderField
              name={name}
              marks={marks}
              value={values[name] ?? ""}
              editing={editing.editing}
              invalid={(values[name] ?? "").trim() === ""}
              onEdit={editing.onEdit}
              onCommit={(value) =>
                setValues((current) => ({ ...current, [name]: value }))
              }
            />
          )}
        />
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">
          Campos ({placeholders.length - missing.length} de {placeholders.length}{" "}
          preenchidos)
        </h3>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {placeholders.map((name) => (
            <li key={name} className="flex flex-col gap-1 px-3 py-2.5">
              <label
                htmlFor={`campo-${name}`}
                className={cn(
                  "font-mono text-micro tracking-[0.1em] uppercase",
                  (values[name] ?? "").trim() === ""
                    ? "text-destructive-soft"
                    : "text-faint",
                )}
              >
                {humanize(name)}
                {(values[name] ?? "").trim() === "" && " (vazio)"}
              </label>
              <Input
                id={`campo-${name}`}
                value={values[name] ?? ""}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setValues((current) => ({ ...current, [name]: value }));
                }}
              />
            </li>
          ))}
        </ul>
      </section>

      {failure !== null && (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(failure, {
            validation: "Revise os campos vazios antes de gerar.",
          })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending} onClick={() => void onGenerate()}>
          {pending ? "Gerando…" : "Gerar documento"}
        </Button>
        {missing.length > 0 && (
          <span className="text-small text-muted-foreground">
            {missing.length === 1
              ? "Um campo ainda está vazio."
              : `${missing.length} campos ainda estão vazios.`}
          </span>
        )}
      </div>
    </div>
  );
}
