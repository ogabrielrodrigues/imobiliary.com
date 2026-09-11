import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { IconAlertCircle, IconAlertTriangle, IconDownload, IconFilePlus, IconPlus, IconTrash } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { DocumentPreview } from "@/components/document-preview";
import { Dropzone } from "@/components/dropzone";
import { FormField } from "@/components/form-field";
import {
  DocxIcon,
  LoadFailure,
  PageBody,
  PageHeader,
  StatusPill,
} from "@/components/page";
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
import { placeholdersOf, type Block } from "@/domain/block";
import { countFilled, suggestFilename } from "@/domain/document";
import type { GeneratedDocument } from "@/domain/document";
import { groupPlaceholders, placeholderSyntax } from "@/domain/placeholder";
import {
  formatBytes,
  validateTemplateFile,
  type Template,
  type TemplateVersion,
} from "@/domain/template";
import { saveFile } from "@/lib/download";
import { relativeDate } from "@/lib/format";
import { queryKeys } from "@/queries/keys";
import { invalidateAfter, templateContentQuery } from "@/queries/options";
import { downloadDocument, generateDocument } from "@/server/documents";
import { deleteTemplate, publishTemplateVersion } from "@/server/templates";

/** The search parameters this screen understands. */
interface TemplateSearch {
  /** Pins a version. Absent means the latest, which keeps the URL canonical. */
  readonly versao?: number;
}

export const Route = createFileRoute("/_app/templates/$templateId")({
  /**
   * The chosen version rides in the URL rather than in component state, so it
   * survives a reload and can be shared or bookmarked.
   *
   * Returning an empty object rather than `{ versao: undefined }` matters: the
   * router serialises whatever comes back, and the second form would append a
   * bare `?versao=` to every link on the page.
   */
  validateSearch: (search: Record<string, unknown>): TemplateSearch => {
    const raw = Number(search["versao"]);
    return Number.isInteger(raw) && raw >= 1 ? { versao: raw } : {};
  },
  // Without this the router treats a change of search as the same match and
  // serves the cached data, so the loader would never see the new version.
  loaderDeps: ({ search }) => ({ versao: search.versao }),
  loader: ({ context, params, deps }) =>
    context.queryClient.ensureQueryData(
      templateContentQuery(params.templateId, deps.versao),
    ),
  head: () => ({ meta: [{ title: "Gerar documento | Imobiliary Docs" }] }),
  component: TemplateDetailPage,
});

function TemplateDetailPage() {
  const { templateId } = Route.useParams();
  const { versao } = Route.useSearch();
  const { data: result } = useSuspenseQuery(templateContentQuery(templateId, versao));

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

  const { template, blocks, versions, previewUnavailable } = result.value;
  const selected = template.version?.version;

  return (
    <GenerateScreen
      // Switching version re-runs the loader without unmounting this component,
      // so without a key the values typed against the previous schema would
      // survive — and the API would then reject fields no longer on screen.
      key={selected}
      template={template}
      blocks={blocks}
      versions={versions}
      previewUnavailable={previewUnavailable}
    />
  );
}

function GenerateScreen({
  template,
  blocks,
  versions,
  previewUnavailable,
}: {
  readonly template: Template;
  readonly blocks: readonly Block[];
  readonly versions: readonly TemplateVersion[];
  readonly previewUnavailable: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The schema the API published is the authority on what must be sent; the
  // preview's own reading only decides where the fields sit on the page.
  const placeholders = template.version?.placeholders ?? placeholdersOf(blocks);
  const shown = template.version?.version ?? template.latestVersion;
  const pinned = shown !== template.latestVersion;

  const [values, setValues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generated, setGenerated] = useState<GeneratedDocument | null>(null);
  const [publishing, setPublishing] = useState(false);

  const filled = countFilled(placeholders, values);
  const missing = new Set(
    placeholders.filter((name) => (values[name] ?? "").trim() === ""),
  );

  function setValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function showVersion(version: number) {
    // Choosing the latest drops the parameter instead of pinning to a number,
    // so "current" keeps a clean address and only a real pin shows in the URL.
    void navigate({
      to: "/templates/$templateId",
      params: { templateId: template.id },
      search: version === template.latestVersion ? {} : { versao: version },
      replace: true,
    });
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
          // Sent only when a version is actually pinned. Passing the latest
          // number unconditionally would fix it to a value that can go stale
          // between this page loading and the request arriving.
          ...(pinned ? { version: shown } : {}),
        },
      });

      if (result.ok) {
        setGenerated(result.value);
        // The new row belongs in Documentos and in the dashboard's counts.
        void invalidateAfter(queryClient, "documentGenerated");
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
            <DeleteTemplate template={template} />
            {versions.length > 1 && (
              <VersionPicker
                versions={versions}
                shown={shown}
                latest={template.latestVersion}
                onChange={showVersion}
              />
            )}
            <Button
              type="button"
              variant="secondary"
              onClick={() => setPublishing((open) => !open)}
            >
              <IconPlus data-icon="inline-start" aria-hidden="true" />
              Nova versão
            </Button>
            <Link
              to="/templates"
              className="rounded-md px-3 py-2 text-small text-muted-foreground hover:text-foreground"
            >
              Voltar
            </Link>
            <Button type="button" disabled={pending} onClick={onGenerate}>
              <IconFilePlus data-icon="inline-start" aria-hidden="true" />
              {pending ? "Gerando…" : "Gerar documento"}
            </Button>
          </>
        }
      />

      <PageBody>
        <div className="flex flex-wrap items-center gap-3 text-small text-muted-foreground">
          <DocxIcon size={28} />
          <span>Versão {shown}</span>
          <Dot />
          {/*
            The version's own date, not the template's. They differ as soon as
            a newer version exists, and "Versão 1 · atualizado agora mesmo"
            would describe the wrong thing entirely.
          */}
          <span>
            {template.version
              ? `Publicada ${relativeDate(template.version.createdAt)}`
              : `Atualizado ${relativeDate(template.updatedAt)}`}
          </span>
          {template.version && (
            <>
              <Dot />
              <span className="font-mono text-fine">
                {formatBytes(template.version.size)}
              </span>
            </>
          )}
        </div>

        {pinned && (
          <p className="flex max-w-3xl items-start gap-2.5 rounded-md border border-docs/35 bg-docs/10 px-4 py-3 text-small text-docs-soft">
            <IconAlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
            Você está vendo a versão {shown}. A atual é a{" "}
            {template.latestVersion}, e o documento gerado aqui usará a{" "}
            {shown}.{" "}
            <button
              type="button"
              onClick={() => showVersion(template.latestVersion)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Ver a versão atual
            </button>
            </span>
          </p>
        )}

        {publishing && (
          <PublishVersion
            template={template}
            onDone={() => setPublishing(false)}
          />
        )}

        {summary != null && (
          <p
            role="alert"
            className="flex items-start gap-2.5 max-w-3xl rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-small text-destructive-soft"
          >
            <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{summary}</span>
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
              <p className="text-caption text-faint">
                Clique em um campo no documento para preenchê-lo. Esta é uma
                leitura simplificada do modelo: o arquivo gerado mantém a
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
 * The version selector.
 *
 * A native select rather than a styled listbox: it is one control, and the
 * browser's own is already correct with a keyboard and on a phone.
 */
function VersionPicker({
  versions,
  shown,
  latest,
  onChange,
}: {
  readonly versions: readonly TemplateVersion[];
  readonly shown: number;
  readonly latest: number;
  readonly onChange: (version: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-small text-muted-foreground">
      <span className="sr-only">Versão do modelo</span>
      <select
        value={shown}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-8.5 rounded-md border border-border-strong bg-input px-2.5 text-small text-foreground outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/20"
      >
        {versions.map((version) => (
          <option key={version.id} value={version.version}>
            v{version.version}
            {version.version === latest ? " · atual" : ""} ·{" "}
            {relativeDate(version.createdAt)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The panel that publishes a new version.
 *
 * Editing a template means adding a version, never rewriting the one that is
 * there: the preview reads a document, it does not model everything Word can
 * hold, so regenerating a .docx from it would quietly drop formatting.
 */
function PublishVersion({
  template,
  onDone,
}: {
  readonly template: Template;
  readonly onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const publish = useMutation({
    mutationFn: (form: FormData) => publishTemplateVersion({ data: form }),
  });
  const pending = publish.isPending;

  function onPick(chosen: File | null) {
    setFile(chosen);
    setFailure(null);

    if (chosen) {
      const problems = validateTemplateFile(chosen);
      if (problems.length > 0) {
        setFailure({ kind: "validation", fields: problems });
      }
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setFailure({
        kind: "validation",
        fields: [{ field: "file", message: "Escolha um arquivo .docx." }],
      });
      return;
    }

    const form = new FormData();
    form.set("templateId", template.id);
    form.set("file", file, file.name);

    setFailure(null);

    const result = await publish.mutateAsync(form);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }

    // Mark the template stale before leaving any pin, so the screen lands on
    // the version just published: the "latest" entry cached for this template
    // still describes the one before.
    await invalidateAfter(queryClient, "versionPublished");
    await navigate({
      to: "/templates/$templateId",
      params: { templateId: template.id },
      search: {},
      replace: true,
    });
    onDone();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">Publicar nova versão</h2>
        <p className="text-caption text-faint">
          Envie um .docx atualizado. Ele vira a versão{" "}
          {template.latestVersion + 1}; as anteriores continuam disponíveis e os
          documentos já gerados não mudam.
        </p>
      </div>

      <Dropzone
        file={file}
        onSelect={onPick}
        error={messageFor(failure, "file")}
      />

      {failure && messageFor(failure, "file") === undefined && (
        <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive">
          <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{summaryOf(failure)}</span>
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Publicando…" : "Publicar versão"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/**
 * Deleting a template, behind a confirmation that says what is actually lost.
 *
 * The API removes it softly, so the documents generated from it stay
 * downloadable — which is the part a person needs to know before deciding.
 */
function DeleteTemplate({ template }: { readonly template: Template }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  // The dialog is mounted only once it has been asked for. Base UI renders
  // its root through a portal, which does not survive hydration here: the
  // whole route would fail once on load and be rebuilt by the error boundary.
  // A modal has nothing to show on the server anyway, so there is nothing to
  // lose. Mounting stays true afterwards so the closing animation still runs.
  const [mounted, setMounted] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => deleteTemplate({ data: id }),
  });
  const pending = remove.isPending;

  function ask() {
    setMounted(true);
    setOpen(true);
  }

  async function onConfirm() {
    setFailure(null);

    const result = await remove.mutateAsync(template.id);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }

    // Leave first, then drop this template's entries: refetching them while
    // still on the screen would ask for a template the API now answers 404
    // for, and flash a failure on the way out.
    await navigate({ to: "/templates" });
    queryClient.removeQueries({ queryKey: [...queryKeys.templates, template.id] });
    await invalidateAfter(queryClient, "templateDeleted");
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Excluir modelo"
        onClick={ask}
        // 40px on a phone: an icon-only button is the easiest target to miss.
        className="text-muted-foreground hover:text-destructive max-md:size-10"
      >
        <IconTrash aria-hidden="true" />
      </Button>

      {mounted && (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Excluir “{template.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Este modelo sai da sua lista e não poderá mais ser usado para
                gerar documentos. Os documentos já gerados a partir dele
                continuam disponíveis para download.
              </AlertDialogDescription>
            </AlertDialogHeader>

            {failure && (
              <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive">
                <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                <span>{summaryOf(failure)}</span>
              </p>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={pending}
                onClick={onConfirm}
              >
                {pending ? "Excluindo…" : "Excluir modelo"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
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
      <summary className="cursor-pointer text-small font-medium text-muted-foreground marker:text-faint">
        Campos ·{" "}
        <span aria-live="polite" className="text-foreground">
          {filled} de {placeholders.length} preenchidos
        </span>
      </summary>

      <div className="mt-4 flex flex-col gap-4">
        {groupPlaceholders(placeholders).map((group) => (
          <section key={group.key ?? "__loose"} className="flex flex-col gap-2">
            {group.label !== null && (
              <h3 className="font-mono text-label font-medium tracking-[0.1em] text-faint uppercase">
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
                        ? "border-docs/40 bg-docs/12 text-docs-soft"
                        : "border-success/40 bg-success/12 text-success-soft",
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
      <p className="text-small text-muted-foreground">
        Este modelo não declara nenhum campo, então não há o que preencher.
      </p>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <p className="text-caption text-faint">
        Não foi possível exibir o conteúdo deste modelo, então os campos vêm
        listados. A geração funciona normalmente.
      </p>

      {groupPlaceholders(placeholders).map((group) => (
        <fieldset
          key={group.key ?? "__loose"}
          className="flex flex-col gap-4 border-0 p-0"
        >
          {group.label !== null && (
            <legend className="font-mono text-label font-medium tracking-[0.1em] text-faint uppercase">
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
          <IconDownload data-icon="inline-start" aria-hidden="true" />
          {saving ? "Preparando…" : "Baixar"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
          Fechar
        </Button>
      </div>
    </section>
  );
}
