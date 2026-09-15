import { IconFileText, IconPencilPlus, IconSearch, IconUpload, IconX } from "@tabler/icons-react";
import { useRef } from "react";
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
import { TEMPLATE_LIST_CAP } from "@/server/templates";

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
            <Button variant="secondary" nativeButton={false} render={<Link to="/templates/criar" />}>
              <IconPencilPlus data-icon="inline-start" aria-hidden="true" />
              Criar no editor
            </Button>
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
            description="Envie um .docx com campos no formato {{.campo}}, ou escreva o modelo aqui mesmo no editor. A plataforma descobre os campos sozinha."
            action={
              <span className="flex flex-wrap justify-center gap-2">
                <Button size="sm" nativeButton={false} render={<Link to="/templates/novo" />}><IconUpload data-icon="inline-start" aria-hidden="true" />Enviar modelo</Button>
                <Button size="sm" variant="secondary" nativeButton={false} render={<Link to="/templates/criar" />}><IconPencilPlus data-icon="inline-start" aria-hidden="true" />Criar no editor</Button>
              </span>
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
 * The search box.
 *
 * The browser's own clear button is hidden: it is drawn by the browser, blue
 * and unlike anything else here, and differs between browsers. The one in its
 * place is the app's ghost icon button, shown only when there is something to
 * clear. Escape clears too, as it does in a native search field.
 */
function SearchBox({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  function clear() {
    onChange("");
    // Back to the field, so clearing and typing again is one motion.
    input.current?.focus();
  }

  return (
    <div role="search" className="relative w-full sm:w-64">
      <IconSearch
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
      />
      <Input
        ref={input}
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
        onKeyDown={(event) => {
          if (event.key === "Escape" && value !== "") {
            event.preventDefault();
            clear();
          }
        }}
        className="pr-9 pl-9 [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value !== "" && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Limpar busca"
          onClick={clear}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
        >
          <IconX aria-hidden="true" className="size-3.5" />
        </Button>
      )}
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
  // The list reads every page up to the cap. Reaching it means more may exist,
  // and the search can only see what it was given.
  const mayBeCut = templates.length >= TEMPLATE_LIST_CAP;

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
          A busca cobre os {TEMPLATE_LIST_CAP} primeiros modelos da lista.
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
