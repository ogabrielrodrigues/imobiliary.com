import { IconAlertCircle, IconUpload } from "@tabler/icons-react";
import { useState } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { Dropzone } from "@/components/dropzone";
import { BoundFormField } from "@/components/form-field";
import { PlaceholderChips } from "@/components/placeholder-chips";
import { PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { validateTemplateUpload } from "@/domain/template";
import type { Template } from "@/domain/template";
import { blurThenChange, formErrors, visibleError } from "@/lib/form";
import { invalidateAfter } from "@/queries/options";
import { createTemplate } from "@/server/templates";

export const Route = createFileRoute("/_app/templates/novo")({
  head: () => ({ meta: [{ title: "Enviar modelo | Imobiliary Docs" }] }),
  component: NewTemplatePage,
});

interface UploadValues {
  readonly name: string;
  readonly description: string;
  readonly file: File | null;
}

const EMPTY: UploadValues = { name: "", description: "", file: null };

/**
 * The domain's upload rules. No file yet is checked as an empty one, which is
 * exactly the case the domain already answers with "Escolha um arquivo .docx."
 */
function uploadErrors(value: UploadValues) {
  return formErrors(
    validateTemplateUpload({ ...value, file: value.file ?? new File([], "") }),
  );
}

function NewTemplatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<Failure | null>(null);
  const [created, setCreated] = useState<Template | null>(null);

  const form = useForm({
    defaultValues: EMPTY,
    validationLogic: blurThenChange,
    validators: { onDynamic: ({ value }) => uploadErrors(value) },
    onSubmit: async ({ value }) => {
      // The validator has already refused a missing file; this only narrows.
      if (value.file === null) return;

      const data = new FormData();
      data.set("name", value.name);
      data.set("description", value.description);
      data.set("file", value.file, value.file.name);

      setFailure(null);
      const result = await createTemplate({ data });
      if (result.ok) {
        setCreated(result.value);
        // The listing may be cached from before this upload existed.
        void invalidateAfter(queryClient, "templateCreated");
        return;
      }
      setFailure(result.failure);
    },
  });

  const pending = useStore(form.store, (state) => state.isSubmitting);
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0);
  const clearFailure = () => setFailure(null);

  if (created) {
    return (
      <>
        <PageHeader title="Modelo enviado" />
        <PageBody>
          <div className="flex max-w-2xl flex-col gap-5 rounded-lg border border-border bg-card p-6">
            <div className="flex flex-col gap-1.5">
              <h2 className="text-lg font-semibold">{created.name}</h2>
              <p className="text-small text-muted-foreground">
                Versão {created.latestVersion} publicada. Estes são os campos
                que encontramos no documento: são exatamente os que você
                preencherá ao gerar.
              </p>
            </div>

            <PlaceholderChips names={created.version?.placeholders ?? []} />

            <div className="flex gap-2">
              <Button type="button" onClick={() => navigate({ to: "/templates" })}>
                Ver meus modelos
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCreated(null);
                  form.reset();
                }}
              >
                <IconUpload data-icon="inline-start" aria-hidden="true" />
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
            className="rounded-md px-3 py-2 text-small text-muted-foreground hover:text-foreground"
          >
            Cancelar
          </Link>
        }
      />
      <PageBody>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
          noValidate
          className="flex max-w-2xl flex-col gap-5"
        >
          {summary != null && (
            <p
              role="alert"
              className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-small text-destructive-soft"
            >
              <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{summary}</span>
            </p>
          )}

          <form.Field name="file">
            {(field) => (
              <Dropzone
                file={field.state.value}
                onSelect={(chosen) => {
                  clearFailure();
                  field.handleChange(chosen);
                  // Picking a file is finishing with the field: checking it
                  // now spares the round trip for the obvious mistakes, the
                  // wrong extension, an empty file, one over the limit.
                  field.handleBlur();
                }}
                error={
                  messageFor(failure, "file") ?? visibleError(field.state.meta, submitted)
                }
              />
            )}
          </form.Field>

          <form.Field name="name">
            {(field) => (
              <BoundFormField
                field={field}
                submitted={submitted}
                serverError={messageFor(failure, "name")}
                onEdit={clearFailure}
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
                onEdit={clearFailure}
                label="Descrição"
                placeholder="Opcional"
              />
            )}
          </form.Field>

          <p className="text-caption leading-relaxed text-faint">
            Marque os campos no Word com{" "}
            <code className="font-mono text-docs">{"{{.nome_do_campo}}"}</code>,
            em minúsculas e sem acentos. Não importa se o Word quebrou o campo
            ao meio enquanto você digitava: nós remontamos.
          </p>

          <Button type="submit" disabled={pending} className="self-start">
            <IconUpload data-icon="inline-start" aria-hidden="true" />
            {pending ? "Enviando…" : "Enviar modelo"}
          </Button>
        </form>
      </PageBody>
    </>
  );
}
