import { IconAlertCircle, IconDeviceFloppy, IconFileTypeDocx } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { BlockEditor } from "@/components/block-editor/block-editor";
import { UnsavedChangesGuard } from "@/components/block-editor/unsaved-changes";
import { LoadFailure, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import type { Block } from "@/domain/block";
import { validateBlocks } from "@/domain/block-source";
import type { Template } from "@/domain/template";
import { templateProblem } from "@/lib/template-errors";
import { invalidateAfter, templateContentQuery } from "@/queries/options";
import { publishTemplateVersionFromBlocks } from "@/server/templates";

export const Route = createFileRoute("/_app/templates/$templateId_/editar")({
  // Always the latest version: saving publishes the next one on top of it.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(templateContentQuery(params.templateId, undefined)),
  head: () => ({ meta: [{ title: "Editar modelo | Imobiliary Docs" }] }),
  component: EditTemplatePage,
});

function EditTemplatePage() {
  const { templateId } = Route.useParams();
  const { data: result } = useSuspenseQuery(templateContentQuery(templateId, undefined));

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Editar modelo" />
        <PageBody>
          <LoadFailure failure={result.failure} />
        </PageBody>
      </>
    );
  }

  const { template, blocks, editable } = result.value;
  return editable ? (
    <EditScreen template={template} initialBlocks={blocks} />
  ) : (
    <NotEditable template={template} />
  );
}

/**
 * A template that came from Word, or was changed in Word after the editor
 * wrote it. Opening it here would throw away everything the editor does not
 * model, so it is not offered; a new version is the way to change it.
 */
function NotEditable({ template }: { readonly template: Template }) {
  return (
    <>
      <PageHeader title="Editar modelo" />
      <PageBody>
        <div className="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-card p-6">
          <div className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border-strong bg-muted text-docs"
            >
              <IconFileTypeDocx className="size-5" />
            </span>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-semibold">{template.name} veio do Word</h2>
              <p className="text-small leading-relaxed text-muted-foreground">
                O editor abre só modelos criados nele. Um documento do Word pode ter tabelas,
                imagens, fontes e margens que o editor não conhece, e salvar por aqui apagaria tudo
                isso. Para mudar este modelo, edite o arquivo no Word e envie como nova versão.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              nativeButton={false}
              render={<Link to="/templates/$templateId" params={{ templateId: template.id }} />}
            >
              Voltar ao modelo
            </Button>
          </div>
        </div>
      </PageBody>
    </>
  );
}

function EditScreen({
  template,
  initialBlocks,
}: {
  readonly template: Template;
  readonly initialBlocks: readonly Block[];
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [blocks, setBlocks] = useState<readonly Block[]>(initialBlocks);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [contentError, setContentError] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    const local = validateBlocks(blocks)[0]?.message;
    setContentError(local);
    if (local !== undefined) return;

    setPending(true);
    setFailure(null);
    try {
      const result = await publishTemplateVersionFromBlocks({
        data: { templateId: template.id, name: template.name, blocks: [...blocks] },
      });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      setDirty(false);
      await invalidateAfter(queryClient, "versionPublished");
      setSaved(true);
    } finally {
      setPending(false);
    }
  }

  // From an effect, once the guard has let go, so leaving does not ask.
  useEffect(() => {
    if (saved) void navigate({ to: "/templates/$templateId", params: { templateId: template.id } });
  }, [saved, navigate, template.id]);

  const serverContent = messageFor(failure, "content") ?? templateProblem(failure);
  const summary = failure !== null && failure.kind !== "validation" ? summaryOf(failure) : undefined;

  return (
    <>
      <PageHeader
        title="Editar modelo"
        actions={
          <>
            <Link
              to="/templates/$templateId"
              params={{ templateId: template.id }}
              className="rounded-md px-3 py-2 text-small text-muted-foreground hover:text-foreground"
            >
              Cancelar
            </Link>
            <Button type="button" disabled={pending || !dirty} onClick={() => void save()}>
              <IconDeviceFloppy data-icon="inline-start" aria-hidden="true" />
              {pending ? "Salvando…" : `Salvar como versão ${template.latestVersion + 1}`}
            </Button>
          </>
        }
      />
      <PageBody>
        <UnsavedChangesGuard when={dirty && !pending} />

        <p className="max-w-3xl text-small text-muted-foreground">
          <span className="font-medium text-foreground">{template.name}</span>, versão{" "}
          {template.latestVersion}. Salvar publica uma nova versão; a atual continua como está, e os
          documentos já gerados não mudam.
        </p>

        {summary != null && (
          <p
            role="alert"
            className="flex max-w-3xl items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-small text-destructive-soft"
          >
            <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{summary}</span>
          </p>
        )}

        <BlockEditor
          initialBlocks={initialBlocks}
          label={`Conteúdo de ${template.name}`}
          error={serverContent ?? contentError}
          onChange={(next) => {
            setBlocks(next);
            setDirty(true);
            setContentError(undefined);
            setFailure(null);
          }}
        />
      </PageBody>
    </>
  );
}
