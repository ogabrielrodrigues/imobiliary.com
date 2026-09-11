import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowsSort,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFiles,
} from "@tabler/icons-react";
import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { createFileRoute, Link } from "@tanstack/react-router";

import { summaryOf, type Failure } from "@/application/result";
import type { DocumentListItem } from "@/application/views";
import {
  EmptyState,
  LoadFailure,
  PageBody,
  PageHeader,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/domain/template";
import { saveFile } from "@/lib/download";
import { shortDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { documentPageQuery } from "@/queries/options";
import { downloadDocument } from "@/server/documents";

interface DocumentsSearch {
  /** One-based, as a person counts. Absent means the first page. */
  readonly pagina?: number;
}

export const Route = createFileRoute("/_app/documentos")({
  /** The page lives in the address, so a reload or a shared link keeps it. */
  validateSearch: (search: Record<string, unknown>): DocumentsSearch => {
    const page = Number(search["pagina"]);
    return Number.isInteger(page) && page > 1 ? { pagina: page } : {};
  },
  loaderDeps: ({ search }) => ({ page: (search.pagina ?? 1) - 1 }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(documentPageQuery(deps.page)),
  head: () => ({ meta: [{ title: "Documentos | Imobiliary Docs" }] }),
  component: DocumentsPage,
});

/*
  Sorting only. The API returns documents newest first and offers no filter,
  so a filter here could only search the page on screen and would pass for a
  search of everything. Sorting is honest about the same limit: it reorders
  the page, and the page says so when there is more than one.
*/
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

const column = createColumnHelper<typeof features, DocumentListItem>();

const columns = column.columns([
  column.accessor((item) => item.document.filename, {
    id: "filename",
    header: "Documento",
    sortFn: sortFn_text,
  }),
  column.accessor((item) => item.templateName ?? "", {
    id: "template",
    header: "Modelo",
    sortFn: sortFn_text,
  }),
  column.accessor((item) => item.document.createdAt, {
    id: "createdAt",
    header: "Gerado em",
    sortFn: sortFn_datetime,
    sortDescFirst: true,
  }),
  column.accessor((item) => item.document.size, {
    id: "size",
    header: "Tamanho",
    sortFn: sortFn_basic,
    sortDescFirst: true,
  }),
]);

/** The order the API already returns, and so the one a page starts in. */
const NEWEST_FIRST = [{ id: "createdAt", desc: true }];

const NO_ITEMS: readonly DocumentListItem[] = [];

function DocumentsPage() {
  const { page: pageIndex } = Route.useLoaderDeps();
  const { data: result } = useSuspenseQuery(documentPageQuery(pageIndex));

  // Tracks which row is being fetched, so only that button says so.
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  const table = useTable({
    features,
    columns,
    data: result.ok ? result.value.items : NO_ITEMS,
    getRowId: (item) => item.document.id,
    initialState: { sorting: NEWEST_FIRST },
    // Two states per column, not three: a third click that silently goes
    // back to the API's order is hard to tell apart from a bug.
    enableSortingRemoval: false,
  });

  async function onDownload(id: string) {
    setSaving(id);
    setFailure(null);

    try {
      const downloaded = await downloadDocument({ data: id });
      if (downloaded.ok) {
        saveFile(
          downloaded.value.filename,
          downloaded.value.contentType,
          downloaded.value.bytes,
        );
        return;
      }
      setFailure(downloaded.failure);
    } finally {
      setSaving(null);
    }
  }

  const summary = summaryOf(failure);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Documentos" />
        <PageBody>
          <LoadFailure failure={result.failure} />
        </PageBody>
      </>
    );
  }

  const { items, page, hasNext } = result.value;
  const rows = table.getRowModel().rows;
  const paged = page > 0 || hasNext;
  const [sorted] = table.state.sorting;
  const sortedBy = sorted === undefined ? undefined : table.getColumn(sorted.id);
  const orderLabel =
    sorted === undefined || sortedBy === undefined
      ? ""
      : `, ordenados por ${String(sortedBy.columnDef.header).toLowerCase()}, ${
          sorted.desc ? "decrescente" : "crescente"
        }`;
  const listLabel = `Documentos gerados${paged ? `, página ${page + 1}` : ""}${orderLabel}`;

  return (
    <>
      <PageHeader title="Documentos" />
      <PageBody>
        {summary != null && (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-small text-destructive-soft"
          >
            <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{summary}</span>
          </p>
        )}

        {items.length === 0 && page > 0 ? (
          // A page past the end: an old link, or the last documents were on
          // a page that has since shrunk. Not the same as having none.
          <EmptyState
            icon={<IconFiles />}
            title="Esta página está vazia"
            description="Não há documentos a partir daqui."
            action={
              <Button size="sm" nativeButton={false} render={<Link to="/documentos" />}>
                Ir para a primeira página
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconFiles />}
            title="Nenhum documento gerado"
            description="Abra um modelo e preencha os campos para gerar seu primeiro documento."
            action={
              <Button
                size="sm"
                nativeButton={false}
                render={<Link to="/templates" />}
              >
                Ver modelos
              </Button>
            }
          />
        ) : (
          <>
            {paged && (
              <p className="text-caption text-faint">
                Clicar num título ordena os documentos desta página.
              </p>
            )}

            {/*
              Below md the table becomes a list of cards: five columns do not
              fit a phone, and a table scrolled sideways hides the one button
              that matters. Both read the same sorted rows, and only one of
              the two is ever displayed, so a screen reader meets the documents
              once.
            */}
            <ul aria-label={listLabel} className="flex flex-col gap-3 md:hidden">
              {rows.map((row) => (
                <DocumentCard
                  key={row.id}
                  item={row.original}
                  saving={saving === row.id}
                  onDownload={onDownload}
                />
              ))}
            </ul>

            <div className="hidden overflow-hidden rounded-lg border border-border bg-card md:block">
              <Table className="border-collapse text-left">
                <caption className="sr-only">{listLabel}</caption>
                <TableHeader>
                  <TableRow className="border-b border-border bg-raised hover:bg-raised">
                    {table.getFlatHeaders().map((header) => {
                      const direction = header.column.getIsSorted();
                      return (
                        <TableHead
                          key={header.id}
                          scope="col"
                          aria-sort={
                            direction === "asc"
                              ? "ascending"
                              : direction === "desc"
                                ? "descending"
                                : undefined
                          }
                          className="h-auto px-5 py-2"
                        >
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className={cn(
                              "-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-label font-medium tracking-[0.08em] uppercase transition-colors hover:text-foreground",
                              direction === false ? "text-faint" : "text-muted-foreground",
                            )}
                          >
                            {String(header.column.columnDef.header)}
                            {direction === "asc" ? (
                              <IconArrowUp aria-hidden="true" className="size-3.5" />
                            ) : direction === "desc" ? (
                              <IconArrowDown aria-hidden="true" className="size-3.5" />
                            ) : (
                              <IconArrowsSort aria-hidden="true" className="size-3.5 opacity-60" />
                            )}
                          </button>
                        </TableHead>
                      );
                    })}
                    <TableHead scope="col" className="h-auto px-5 py-3">
                      <span className="sr-only">Ações</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <DocumentRow
                      key={row.id}
                      item={row.original}
                      saving={saving === row.id}
                      onDownload={onDownload}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            {paged && <Pagination page={page} hasNext={hasNext} />}
          </>
        )}
      </PageBody>
    </>
  );
}

/**
 * Previous and next, as links: each page has an address, so the browser's
 * back button, a new tab and a bookmark all work.
 */
function Pagination({ page, hasNext }: { readonly page: number; readonly hasNext: boolean }) {
  // Page 1 has no parameter, so the first page keeps one canonical address.
  const searchFor = (index: number) => (index === 0 ? {} : { pagina: index + 1 });

  return (
    <nav aria-label="Paginação" className="flex items-center justify-between gap-3">
      {page > 0 ? (
        <Button
          size="sm"
          variant="secondary"
          nativeButton={false}
          render={<Link to="/documentos" search={searchFor(page - 1)} />}
          className="max-md:h-10"
        >
          <IconChevronLeft data-icon="inline-start" aria-hidden="true" />
          Anterior
        </Button>
      ) : (
        <span />
      )}
      <span className="text-small text-muted-foreground tabular-nums">Página {page + 1}</span>
      {hasNext ? (
        <Button
          size="sm"
          variant="secondary"
          nativeButton={false}
          render={<Link to="/documentos" search={searchFor(page + 1)} />}
          className="max-md:h-10"
        >
          Próxima
          <IconChevronRight data-icon="inline-end" aria-hidden="true" />
        </Button>
      ) : (
        <span />
      )}
    </nav>
  );
}

/** One document as a card, for screens too narrow for the table. */
function DocumentCard({
  item,
  saving,
  onDownload,
}: {
  readonly item: DocumentListItem;
  readonly saving: boolean;
  readonly onDownload: (id: string) => void;
}) {
  const { document, templateName } = item;

  return (
    <li className="flex flex-col gap-2.5 rounded-lg border border-border bg-card px-4 py-3.5">
      <span className="text-control font-medium break-all">{document.filename}</span>
      <span className="text-small text-muted-foreground">
        {templateName === null ? (
          <span className="text-faint italic">modelo indisponível</span>
        ) : (
          <Link
            to="/templates/$templateId"
            params={{ templateId: document.templateId }}
            className="hover:text-foreground hover:underline"
          >
            {templateName}
          </Link>
        )}
        <span className="ml-2 font-mono text-meta text-faint">
          v{document.templateVersion}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <time dateTime={document.createdAt.toISOString()}>
          {shortDateTime(document.createdAt)}
        </time>
        <span className="font-mono tabular-nums">{formatBytes(document.size)}</span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={saving}
        onClick={() => onDownload(document.id)}
        className="h-10 self-start"
      >
        <IconDownload data-icon="inline-start" aria-hidden="true" />
        {saving ? "Preparando…" : "Baixar"}
      </Button>
    </li>
  );
}

function DocumentRow({
  item,
  saving,
  onDownload,
}: {
  readonly item: DocumentListItem;
  readonly saving: boolean;
  readonly onDownload: (id: string) => void;
}) {
  const { document, templateName } = item;

  return (
    <TableRow className="border-b border-muted hover:bg-row-hover">
      <TableCell className="px-5 py-3.5 text-control whitespace-normal">
        {document.filename}
      </TableCell>

      <TableCell className="px-5 py-3.5 text-small whitespace-normal text-muted-foreground">
        {templateName === null ? (
          // The template was deleted, or sits beyond the page fetched to
          // resolve names. Saying so beats printing a bare identifier.
          <span className="text-faint italic">modelo indisponível</span>
        ) : (
          <Link
            to="/templates/$templateId"
            params={{ templateId: document.templateId }}
            className="hover:text-foreground hover:underline"
          >
            {templateName}
          </Link>
        )}
        <span className="ml-2 font-mono text-meta text-faint">
          v{document.templateVersion}
        </span>
      </TableCell>

      <TableCell className="px-5 py-3.5 text-small text-muted-foreground">
        <time dateTime={document.createdAt.toISOString()}>
          {shortDateTime(document.createdAt)}
        </time>
      </TableCell>

      <TableCell className="px-5 py-3.5 font-mono text-caption tabular-nums text-muted-foreground">
        {formatBytes(document.size)}
      </TableCell>

      <TableCell className="px-5 py-3.5 text-right">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={saving}
          onClick={() => onDownload(document.id)}
        >
          <IconDownload data-icon="inline-start" aria-hidden="true" />
          {saving ? "Preparando…" : "Baixar"}
        </Button>
      </TableCell>
    </TableRow>
  );
}
