import { IconAlertCircle, IconDeviceFloppy } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { BlockEditor } from "@/components/block-editor/block-editor";
import { UnsavedChangesGuard } from "@/components/block-editor/unsaved-changes";
import { BoundFormField } from "@/components/form-field";
import { PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import type { Block } from "@imobiliary/docx/blocks";
import { validateBlocks } from "@imobiliary/docx/block-source";
import { validateTemplateDetails } from "@/domain/template";
import { blurThenChange, formErrors } from "@/lib/form";
import { templateProblem } from "@/lib/template-errors";
import { invalidateAfter } from "@/queries/options";
import { createTemplateFromBlocks } from "@/server/templates";

export const Route = createFileRoute("/_app/templates/criar")({
  head: () => ({ meta: [{ title: "Criar modelo | Imobiliary Docs" }] }),
  component: CreateTemplatePage,
});

/**
 * A template written here instead of in Word.
 *
 * The name and description follow the form rule every screen uses; the
 * document is checked when saving, since "not finished yet" is the normal
 * state of a document being written, not an error to show while typing.
 */
function CreateTemplatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [dirty, setDirty] = useState(false);
  const [contentError, setContentError] = useState<string | undefined>();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { name: "", description: "" },
    validationLogic: blurThenChange,
    validators: { onDynamic: ({ value }) => formErrors(validateTemplateDetails(value)) },
    onSubmit: async ({ value }) => {
      const local = validateBlocks(blocks)[0]?.message;
      setContentError(local);
      if (local !== undefined) return;

      setFailure(null);
      const result = await createTemplateFromBlocks({
        data: { name: value.name, description: value.description, blocks },
      });
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }

      setDirty(false);
      await invalidateAfter(queryClient, "templateCreated");
      setCreatedId(result.value.id);
    },
  });

  // Navigating from an effect, not from the submit handler: by now the guard
  // has re-rendered without changes to protect and let go of the router, so
  // leaving for the new template does not ask whether to discard it.
  useEffect(() => {
    if (createdId !== null) {
      void navigate({ to: "/templates/$templateId", params: { templateId: createdId } });
    }
  }, [createdId, navigate]);

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);
  const clearFailure = () => setFailure(null);
  const serverContent = messageFor(failure, "content") ?? templateProblem(failure);
  const summary =
    failure !== null && failure.kind !== "validation" ? summaryOf(failure) : undefined;

  return (
    <>
      <PageHeader
        title="Criar modelo"
        actions={
          <>
            <Link
              to="/templates"
              className="rounded-md px-3 py-2 text-small text-muted-foreground hover:text-foreground"
            >
              Cancelar
            </Link>
            <Button type="submit" form="criar-modelo" disabled={pending}>
              <IconDeviceFloppy data-icon="inline-start" aria-hidden="true" />
              {pending ? "Salvando…" : "Salvar modelo"}
            </Button>
          </>
        }
      />
      <PageBody>
        <UnsavedChangesGuard when={dirty && !pending} />

        <form
          id="criar-modelo"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          noValidate
          className="flex flex-col gap-5"
        >
          {summary != null && (
            <p
              role="alert"
              className="flex max-w-3xl items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-small text-destructive-soft"
            >
              <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{summary}</span>
            </p>
          )}

          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <form.Field name="name">
              {(field) => (
                <BoundFormField
                  field={field}
                  submitted={submitted}
                  serverError={messageFor(failure, "name")}
                  onEdit={() => {
                    clearFailure();
                    setDirty(true);
                  }}
                  label="Nome do modelo"
                  placeholder="Contrato de locação residencial"
                />
              )}
            </form.Field>
            <form.Field name="description">
              {(field) => (
                <BoundFormField
                  field={field}
                  submitted={submitted}
                  serverError={messageFor(failure, "description")}
                  onEdit={() => {
                    clearFailure();
                    setDirty(true);
                  }}
                  label="Descrição"
                  placeholder="Opcional"
                />
              )}
            </form.Field>
          </div>

          <BlockEditor
            initialBlocks={[]}
            label="Conteúdo do modelo"
            error={serverContent ?? contentError}
            onChange={(next) => {
              setBlocks(next);
              setDirty(true);
              setContentError(undefined);
              clearFailure();
            }}
          />
        </form>
      </PageBody>
    </>
  );
}
