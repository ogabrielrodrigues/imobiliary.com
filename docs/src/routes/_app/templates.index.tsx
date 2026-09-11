import { IconFileText, IconSearch, IconUpload } from "@tabler/icons-react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import {
  DocxIcon,
  EmptyState,
  LoadFailure,
  PageBody,
  PageHeader,
  StatusPill,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { matchesTemplateSearch, type Template } from "@/domain/template";
import { relativeDate } from "@/lib/format";
import { templateListQuery } from "@/queries/options";
import { TEMPLATE_LIST_LIMIT } from "@/server/templates";

interface TemplatesSearch {
  /** What was typed in the search box. Absent when empty. */
  readonly busca?: string;
}

export const Route = createFileRoute("/_app/templates/")({
  /**
   * The search rides in the address, so coming back from a template keeps it.
   * The loader does not depend on it: filtering happens on what is already
   * fetched, and a keystroke must never become a request.
   */
  validateSearch: (search: Record<string, unknown>): TemplatesSearch => {
    const query = search["busca"];
    return typeof query === "string" && query.trim() !== "" ? { busca: query } : {};
  },
  head: () => ({ meta: [{ title: "Templates | Imobiliary Docs" }] }),
  loader: ({ context }) => context.queryClient.ensureQueryData(templateListQuery()),
  component: TemplatesPage,
});

function TemplatesPage() {
  const { data: result } = useSuspenseQuery(templateListQuery());
  const { busca = "" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const hasTemplates = result.ok && result.value.length > 0;

  return (
    <>
      <PageHeader
        title="Templates"
        actions={
          <>
            {hasTemplates && (
              <SearchBox
                value={busca}
                onChange={(value) =>
                  void navigate({
                    search: value.trim() === "" ? {} : { busca: value },
                    replace: true,
                  })
                }
              />
            )}
            <Button nativeButton={false} render={<Link to="/templates/novo" />}>
              <IconUpload data-icon="inline-start" aria-hidden="true" />
              Enviar modelo
            </Button>
          </>
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
          <TemplateResults
            templates={result.value}
            query={busca}
            onClear={() => void navigate({ search: {}, replace: true })}
          />
        )}
      </PageBody>
    </>
  );
}

/**
 * The search box. type="search" gives the browser's own clear button and lets
 * Escape empty it.
 */
function SearchBox({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div role="search" className="relative w-full sm:w-64">
      <IconSearch
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
      />
      <Input
        type="search"
        aria-label="Buscar modelos"
        placeholder="Buscar modelos"
        autoComplete="off"
        value={value}
        onChange={(event) => {
          // Captured before anything else runs: React nulls currentTarget once
          // the handler returns.
          const next = event.currentTarget.value;
          onChange(next);
        }}
        className="pl-9"
      />
    </div>
  );
}

function TemplateResults({
  templates,
  query,
  onClear,
}: {
  readonly templates: readonly Template[];
  readonly query: string;
  readonly onClear: () => void;
}) {
  const shown = templates.filter((template) => matchesTemplateSearch(template, query));
  const searching = query.trim() !== "";
  // A full page means there may be more than the API handed over, and the
  // search can only see what it was given.
  const mayBeCut = templates.length >= TEMPLATE_LIST_LIMIT;

  return (
    <>
      {/* Read out as the results change, so a screen reader hears the effect of typing. */}
      <p aria-live="polite" className="sr-only">
        {searching
          ? `${shown.length} ${shown.length === 1 ? "modelo encontrado" : "modelos encontrados"}`
          : ""}
      </p>

      {searching && mayBeCut && (
        <p className="text-caption text-faint">
          A busca cobre os {TEMPLATE_LIST_LIMIT} primeiros modelos da lista.
        </p>
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={<IconSearch />}
          title="Nenhum modelo encontrado"
          description={`Nada corresponde a “${query.trim()}”. Confira a grafia ou busque por outra palavra do nome ou da descrição.`}
          action={
            <Button size="sm" variant="secondary" onClick={onClear}>
              Limpar busca
            </Button>
          }
        />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
          {shown.map((template) => (
            <li key={template.id}>
              <TemplateCard template={template} />
            </li>
          ))}
        </ul>
      )}
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
