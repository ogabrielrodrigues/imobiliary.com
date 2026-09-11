import { IconFileText, IconUpload } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";

import {
  DocxIcon,
  EmptyState,
  LoadFailure,
  PageBody,
  PageHeader,
  StatusPill,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import type { Template } from "@/domain/template";
import { relativeDate } from "@/lib/format";
import { listTemplates } from "@/server/templates";

export const Route = createFileRoute("/_app/templates/")({
  head: () => ({ meta: [{ title: "Templates | Imobiliary Docs" }] }),
  loader: () => listTemplates(),
  component: TemplatesPage,
});

function TemplatesPage() {
  const result = Route.useLoaderData();

  return (
    <>
      <PageHeader
        title="Templates"
        actions={
          <Button nativeButton={false} render={<Link to="/templates/novo" />}><IconUpload data-icon="inline-start" aria-hidden="true" />Enviar modelo</Button>
        }
      />
      <PageBody>
        {!result.ok ? (
          <LoadFailure failure={result.failure} />
        ) : result.value.length === 0 ? (
          <EmptyState
            icon={<IconFileText />}
            title="Nenhum template ainda"
            description="Envie um .docx com campos no formato {{.campo}} para começar. A plataforma descobre os campos sozinha."
            action={
              <Button size="sm" nativeButton={false} render={<Link to="/templates/novo" />}><IconUpload data-icon="inline-start" aria-hidden="true" />Enviar modelo</Button>
            }
          />
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {result.value.map((template) => (
              <li key={template.id}>
                <TemplateCard template={template} />
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}

function TemplateCard({ template }: { readonly template: Template }) {
  const fields = template.version?.placeholders.length;

  return (
    <Link
      to="/templates/$templateId"
      params={{ templateId: template.id }}
      className="flex h-full flex-col gap-3.5 rounded-lg border border-border bg-card p-5 transition-colors hover:border-border-hover hover:bg-row-hover"
    >
      <div className="flex items-start gap-3">
        <DocxIcon />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm leading-tight font-semibold">
            {template.name}
          </span>
          <p className="text-xs text-faint">
            Atualizado {relativeDate(template.updatedAt)}
          </p>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between">
        <span className="font-mono text-meta text-muted-foreground">
          {/*
            A listed template carries no version, so the field count is only
            known once one is opened. Saying "versão N" is honest; inventing a
            count would not be.
          */}
          {fields === undefined
            ? `versão ${template.latestVersion}`
            : `${fields} ${fields === 1 ? "campo" : "campos"}`}
        </span>
        <StatusPill tone="success">Pronto</StatusPill>
      </div>
    </Link>
  );
}
