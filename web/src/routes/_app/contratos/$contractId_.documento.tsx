import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconArrowLeft, IconFileText } from "@tabler/icons-react";

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
  type Template,
} from "@/domain/document";
import { ROLE_LABELS } from "@/domain/contract";
import { cn } from "@/lib/utils";
import { getContract } from "@/server/contracts";
import {
  generateContractDocument,
  getDocumentDraft,
  listTemplates,
} from "@/server/documents";

export const Route = createFileRoute("/_app/contratos/$contractId_/documento")({
  loader: async ({ params }) => ({
    contract: await getContract({ data: params.contractId }),
    templates: await listTemplates(),
  }),
  head: () => ({ meta: [{ title: "Gerar documento | Imobiliary" }] }),
  component: GenerateDocumentPage,
});

/**
 * Generating a document from this contract, in two steps.
 *
 * First the template, then the review: the contract answers most of what a
 * lease template asks, and the review is where the office reads the document
 * with those answers in place and changes anything it wants before the file is
 * written. A field the contract cannot answer is shown empty, marked, and
 * filled here.
 */
function GenerateDocumentPage() {
  const { contractId } = Route.useParams();
  const { contract, templates } = Route.useLoaderData();
  const [templateId, setTemplateId] = useState<string | null>(null);

  const back = (
    <Link
      to="/contratos/$contractId"
      params={{ contractId }}
      className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground"
    >
      <IconArrowLeft aria-hidden="true" className="size-4" />
      Voltar ao contrato
    </Link>
  );

  if (!contract.ok) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {summaryOf(contract.failure, {
            not_found: "Este contrato não existe ou foi excluído.",
          })}
        </p>
      </div>
    );
  }

  if (!templates.ok) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {summaryOf(templates.failure, {
            authentication:
              "Não foi possível falar com o serviço de documentos. Entre novamente.",
          })}
        </p>
      </div>
    );
  }

  const tenant =
    contract.value.parties.find((party) => party.role === "tenant")?.name ?? "";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        {back}
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">
          Gerar documento
        </h1>
        <p className="text-small text-muted-foreground">
          Contrato {contract.value.registry}
          {tenant === "" ? "" : `, ${ROLE_LABELS.tenant.toLowerCase()} ${tenant}`}
        </p>
      </header>

      {templateId === null ? (
        <TemplateChoice templates={templates.value} onChoose={setTemplateId} />
      ) : (
        <Review
          contractId={contractId}
          templateId={templateId}
          registry={contract.value.registry}
          tenant={tenant}
          onBack={() => setTemplateId(null)}
        />
      )}
    </div>
  );
}

/** The office's templates, as they are kept in Imobiliary Docs. */
function TemplateChoice({
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
 * The review: the document with the contract's answers in place.
 *
 * The values live here, so the preview and the list of fields can never
 * disagree about what will be sent. What is sent is exactly what is on screen.
 */
function Review({
  contractId,
  templateId,
  registry,
  tenant,
  onBack,
}: {
  readonly contractId: string;
  readonly templateId: string;
  readonly registry: string;
  readonly tenant: string;
  readonly onBack: () => void;
}) {
  const navigate = useNavigate();
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
    void getDocumentDraft({ data: { contractId, templateId } }).then((result) => {
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
          contractRegistry: registry,
          tenant,
        }),
      );
    });
    return () => {
      current = false;
    };
  }, [contractId, templateId, registry, tenant]);

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
    const result = await generateContractDocument({
      data: { contractId, templateId, filename, values },
    });
    setPending(false);

    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await navigate({ to: "/contratos/$contractId", params: { contractId } });
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
        hint="É assim que ele aparece no contrato e no histórico do Imobiliary Docs."
        error={messageFor(failure, "filename")}
        value={filename}
        placeholder="Contrato 2026/001 - Nome"
        onChange={(event) => setFilename(event.currentTarget.value)}
      />

      {unknown.length > 0 && (
        <p className="rounded-md border border-docs/35 bg-docs/5 px-3 py-2 text-small text-docs-soft">
          Este modelo pede {unknown.length === 1 ? "um campo" : `${unknown.length} campos`}{" "}
          que o contrato não responde: {unknown.map(humanize).join(", ")}. Preencha
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
