import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowsSort,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFileZip,
  IconFiles,
  IconStack2,
  IconTrash,
} from "@tabler/icons-react";
import { useId, useState, type ReactNode } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
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
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import type { FileContent } from "@/application/ports";
import { summaryOf, type Failure, type Result } from "@/application/result";
import type { DocumentListItem, HistoryItem, TemplateOption } from "@/application/views";
import {
  EmptyState,
  LoadFailure,
  PageBody,
  PageHeader,
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
import { Label } from "@/components/ui/label";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { batchCount, type Batch } from "@/domain/batch";
import { displayName } from "@/domain/document-name";
import { formatBytes } from "@/domain/template";
import { saveFile } from "@/lib/download";
import { shortDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/queries/keys";
import { batchDocumentsQuery, historyPageQuery, invalidateAfter } from "@/queries/options";
import { deleteDocument, downloadDocument } from "@/server/documents";
import { deleteBatch, downloadBatch } from "@/server/history";

interface DocumentsSearch {
  /** One-based, as a person counts. Absent means the first page. */
  readonly pagina?: number;
  /** A template id: only what was generated from it. */
  readonly modelo?: string;
}

const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/_app/documentos")({
  /**
   * The page and the template filter live in the address, so a reload, the
   * back button and a shared link all keep them.
   */
  validateSearch: (search: Record<string, unknown>): DocumentsSearch => {
    const page = Number(search["pagina"]);
    const template = search["modelo"];
    return {
      ...(Number.isInteger(page) && page > 1 ? { pagina: page } : {}),
      ...(typeof template === "string" && IDENTIFIER.test(template) ? { modelo: template } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ page: (search.pagina ?? 1) - 1, templateId: search.modelo }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(historyPageQuery(deps.page, deps.templateId)),
  head: () => ({ meta: [{ title: "Documentos | Imobiliary Docs" }] }),
  component: DocumentsPage,
});

/*
  The history: documents generated on their own and batches, mixed, newest
  first. A batch is one row, closed until someone opens it.

  Sorting reorders the entries of the page on screen. The documents inside an
  open batch are not sorted with them: they stay newest first, the order the
  API lists them in.
*/
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

const column = createColumnHelper<typeof features, HistoryItem>();

const columns = column.columns([
  column.accessor(
    (entry) => (entry.kind === "batch" ? entry.batch.name : displayName(entry.item.document.filename)),
    { id: "name", header: "Documento", sortFn: sortFn_text },
  ),
  column.accessor(
    (entry) => (entry.kind === "batch" ? entry.templateName : entry.item.templateName) ?? "",
    { id: "template", header: "Modelo", sortFn: sortFn_text },
  ),
  column.accessor(
    (entry) => (entry.kind === "batch" ? entry.batch.createdAt : entry.item.document.createdAt),
    { id: "createdAt", header: "Gerado em", sortFn: sortFn_datetime, sortDescFirst: true },
  ),
  column.accessor((entry) => (entry.kind === "batch" ? entry.batch.size : entry.item.document.size), {
    id: "size",
    header: "Tamanho",
    sortFn: sortFn_basic,
    sortDescFirst: true,
  }),
]);

/** The order the API already returns, and so the one a page starts in. */
const NEWEST_FIRST = [{ id: "createdAt", desc: true }];

const NO_ITEMS: readonly HistoryItem[] = [];

const entryId = (entry: HistoryItem) =>
  entry.kind === "batch" ? `batch:${entry.batch.id}` : `document:${entry.item.document.id}`;

/**
 * Downloads, one at a time per row: which row is being fetched, and what went
 * wrong. Shared by the table, the cards and the rows inside a batch.
 */
function useDownloads() {
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function run(key: string, fetch: () => Promise<Result<FileContent>>) {
    setSaving(key);
    setFailure(null);
    try {
      const result = await fetch();
      if (result.ok) {
        saveFile(result.value.filename, result.value.contentType, result.value.bytes);
        return;
      }
      setFailure(result.failure);
    } finally {
      setSaving(null);
    }
  }

  return {
    saving,
    failure,
    document: (id: string) => run(`document:${id}`, () => downloadDocument({ data: id })),
    batch: (id: string) => run(`batch:${id}`, () => downloadBatch({ data: id })),
  };
}

type Downloads = ReturnType<typeof useDownloads>;

function DocumentsPage() {
  const { page: pageIndex, templateId } = Route.useLoaderDeps();
  const { data: result } = useSuspenseQuery(historyPageQuery(pageIndex, templateId));
  const navigate = useNavigate({ from: Route.fullPath });
  const downloads = useDownloads();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  const table = useTable({
    features,
    columns,
    data: result.ok ? result.value.items : NO_ITEMS,
    getRowId: entryId,
    initialState: { sorting: NEWEST_FIRST },
    // Two states per column, not three: a third click that silently goes
    // back to the API's order is hard to tell apart from a bug.
    enableSortingRemoval: false,
  });

  function toggle(batchId: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  }

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

  const { items, page, hasNext, templates } = result.value;
  const rows = table.getRowModel().rows;
  const paged = page > 0 || hasNext;
  const summary = summaryOf(downloads.failure);
  const filterName = templates.find((t) => t.id === templateId)?.name;

  const [sorted] = table.state.sorting;
  const sortedBy = sorted === undefined ? undefined : table.getColumn(sorted.id);
  const orderLabel =
    sorted === undefined || sortedBy === undefined
      ? ""
      : `, ordenados por ${String(sortedBy.columnDef.header).toLowerCase()}, ${
          sorted.desc ? "decrescente" : "crescente"
        }`;
  const listLabel =
    `Documentos gerados${filterName === undefined ? "" : ` do modelo ${filterName}`}` +
    `${paged ? `, página ${page + 1}` : ""}${orderLabel}`;

  function filterBy(id: string) {
    // A new filter starts from the first page: the old page number means
    // nothing in a different list.
    void navigate({ search: id === "" ? {} : { modelo: id }, replace: true });
  }

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

        {(templates.length > 0 || templateId !== undefined) && (
          <TemplateFilter templates={templates} value={templateId} onChange={filterBy} />
        )}

        {items.length === 0 && page > 0 ? (
          // A page past the end: an old link, or the last entries were on a
          // page that has since shrunk. Not the same as having none.
          <EmptyState
            icon={<IconFiles />}
            title="Esta página está vazia"
            description="Não há documentos a partir daqui."
            action={
              <Button
                size="sm"
                nativeButton={false}
                render={<Link to="/documentos" search={templateId === undefined ? {} : { modelo: templateId }} />}
              >
                Ir para a primeira página
              </Button>
            }
          />
        ) : items.length === 0 && templateId !== undefined ? (
          <EmptyState
            icon={<IconFiles />}
            title="Nenhum documento deste modelo"
            description="Nada foi gerado a partir dele ainda."
            action={
              <Button size="sm" variant="secondary" onClick={() => filterBy("")}>
                Ver todos os documentos
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<IconFiles />}
            title="Nenhum documento gerado"
            description="Abra um modelo e preencha os campos para gerar seu primeiro documento."
            action={
              <Button size="sm" nativeButton={false} render={<Link to="/templates" />}>
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
              {rows.map(({ original: entry }) =>
                entry.kind === "batch" ? (
                  <BatchCard
                    key={entryId(entry)}
                    batch={entry.batch}
                    templateName={entry.templateName}
                    open={open.has(entry.batch.id)}
                    onToggle={() => toggle(entry.batch.id)}
                    downloads={downloads}
                  />
                ) : (
                  <DocumentCard key={entryId(entry)} item={entry.item} downloads={downloads} />
                ),
              )}
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
                {/*
                  One tbody per entry, which a table allows: an open batch
                  adds a second one holding its documents, and that element is
                  what the batch's toggle points at with aria-controls.
                */}
                {rows.map(({ original: entry }) =>
                  entry.kind === "batch" ? (
                    <BatchRows
                      key={entryId(entry)}
                      batch={entry.batch}
                      templateName={entry.templateName}
                      open={open.has(entry.batch.id)}
                      onToggle={() => toggle(entry.batch.id)}
                      downloads={downloads}
                    />
                  ) : (
                    <tbody key={entryId(entry)}>
                      <DocumentRow item={entry.item} downloads={downloads} />
                    </tbody>
                  ),
                )}
              </Table>
            </div>

            {paged && <Pagination page={page} hasNext={hasNext} templateId={templateId} />}
          </>
        )}
      </PageBody>
    </>
  );
}

/**
 * The template filter. A native select, like the others on these screens: the
 * browser's own is already right with a keyboard and on a phone.
 */
function TemplateFilter({
  templates,
  value,
  onChange,
}: {
  readonly templates: readonly TemplateOption[];
  readonly value: string | undefined;
  readonly onChange: (templateId: string) => void;
}) {
  const id = useId();
  // A filter on a template that is no longer listed (deleted since the link
  // was made) still filters, and the select says so instead of showing "all".
  const unlisted = value !== undefined && !templates.some((t) => t.id === value);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <Label htmlFor={id}>Modelo</Label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-9.5 w-full max-w-72 rounded-md border border-input-border bg-input px-3 text-sm text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 sm:w-72"
      >
        <option value="">Todos os modelos</option>
        {unlisted && <option value={value}>Modelo indisponível</option>}
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Previous and next, as links: each page has an address, so the browser's
 * back button, a new tab and a bookmark all work. The filter travels with it.
 */
function Pagination({
  page,
  hasNext,
  templateId,
}: {
  readonly page: number;
  readonly hasNext: boolean;
  readonly templateId: string | undefined;
}) {
  // Page 1 has no parameter, so the first page keeps one canonical address.
  const searchFor = (index: number) => ({
    ...(templateId === undefined ? {} : { modelo: templateId }),
    ...(index === 0 ? {} : { pagina: index + 1 }),
  });

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

function TemplateName({
  templateId,
  templateName,
  version,
}: {
  readonly templateId: string;
  readonly templateName: string | null;
  readonly version: number;
}) {
  return (
    <>
      {templateName === null ? (
        // The template was deleted. Saying so beats printing a bare identifier.
        <span className="text-faint italic">modelo indisponível</span>
      ) : (
        <Link
          to="/templates/$templateId"
          params={{ templateId }}
          className="hover:text-foreground hover:underline"
        >
          {templateName}
        </Link>
      )}
      <span className="ml-2 font-mono text-meta text-faint">v{version}</span>
    </>
  );
}

function DownloadButton({
  busy,
  onClick,
  label,
  zip = false,
  className,
}: {
  readonly busy: boolean;
  readonly onClick: () => void;
  readonly label: string;
  readonly zip?: boolean;
  readonly className?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={busy}
      onClick={onClick}
      aria-label={label}
      className={className}
    >
      {zip ? (
        <IconFileZip data-icon="inline-start" aria-hidden="true" />
      ) : (
        <IconDownload data-icon="inline-start" aria-hidden="true" />
      )}
      {busy ? "Preparando…" : zip ? "Baixar ZIP" : "Baixar"}
    </Button>
  );
}

/** One document as a card, for screens too narrow for the table. */
function DocumentCard({
  item,
  downloads,
  nested = false,
}: {
  readonly item: DocumentListItem;
  readonly downloads: Downloads;
  readonly nested?: boolean;
}) {
  const { document, templateName } = item;
  const name = displayName(document.filename);

  return (
    <li
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border border-border bg-card px-4 py-3.5",
        nested && "border-dashed bg-transparent",
      )}
    >
      <span className="text-control font-medium break-all">{name}</span>
      {!nested && (
        <span className="text-small text-muted-foreground">
          <TemplateName
            templateId={document.templateId}
            templateName={templateName}
            version={document.templateVersion}
          />
        </span>
      )}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <time dateTime={document.createdAt.toISOString()}>{shortDateTime(document.createdAt)}</time>
        <span className="font-mono tabular-nums">{formatBytes(document.size)}</span>
      </span>
      <span className="flex items-center gap-2">
        <DownloadButton
          busy={downloads.saving === `document:${document.id}`}
          onClick={() => void downloads.document(document.id)}
          label={`Baixar ${name}`}
          className="h-10"
        />
        <DeleteDocument id={document.id} name={name} />
      </span>
    </li>
  );
}

function DocumentRow({
  item,
  downloads,
  nested = false,
}: {
  readonly item: DocumentListItem;
  readonly downloads: Downloads;
  readonly nested?: boolean;
}) {
  const { document, templateName } = item;
  const name = displayName(document.filename);

  return (
    <TableRow className={cn("border-b border-muted hover:bg-row-hover", nested && "bg-raised/40")}>
      <TableCell className={cn("px-5 py-3.5 text-control whitespace-normal", nested && "pl-14")}>
        {name}
      </TableCell>

      <TableCell className="px-5 py-3.5 text-small whitespace-normal text-muted-foreground">
        {nested ? (
          <span className="font-mono text-meta text-faint">v{document.templateVersion}</span>
        ) : (
          <TemplateName
            templateId={document.templateId}
            templateName={templateName}
            version={document.templateVersion}
          />
        )}
      </TableCell>

      <TableCell className="px-5 py-3.5 text-small text-muted-foreground">
        <time dateTime={document.createdAt.toISOString()}>{shortDateTime(document.createdAt)}</time>
      </TableCell>

      <TableCell className="px-5 py-3.5 font-mono text-caption tabular-nums text-muted-foreground">
        {formatBytes(document.size)}
      </TableCell>

      <TableCell className="px-5 py-3.5 text-right">
        <span className="inline-flex items-center gap-1.5">
          <DownloadButton
            busy={downloads.saving === `document:${document.id}`}
            onClick={() => void downloads.document(document.id)}
            label={`Baixar ${name}`}
          />
          <DeleteDocument id={document.id} name={name} />
        </span>
      </TableCell>
    </TableRow>
  );
}

/** The button that opens and closes a batch, for the row and for the card. */
function BatchToggle({
  batch,
  open,
  onToggle,
  controls,
  children,
}: {
  readonly batch: Batch;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly controls: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={`${open ? "Ocultar" : "Mostrar"} os ${batchCount(batch.documents)} do lote ${batch.name}`}
      className="group -mx-1.5 flex min-w-0 items-start gap-2 rounded-md px-1.5 py-0.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
    >
      <IconChevronRight
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground",
          open && "rotate-90",
        )}
      />
      {children}
    </button>
  );
}

function BatchLabel({ batch }: { readonly batch: Batch }) {
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2 text-control font-medium">
        <IconStack2 aria-hidden="true" className="size-4 shrink-0 text-docs-soft" />
        <span className="break-words">{batch.name}</span>
      </span>
      <span className="self-start rounded-full border border-docs/35 bg-docs/10 px-2 py-0.5 text-label text-docs-soft">
        Lote · {batchCount(batch.documents)}
      </span>
    </span>
  );
}

/** A batch in the table: its row, and its documents below it once opened. */
function BatchRows({
  batch,
  templateName,
  open,
  onToggle,
  downloads,
}: {
  readonly batch: Batch;
  readonly templateName: string | null;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly downloads: Downloads;
}) {
  const contentId = `batch-${batch.id}-table`;

  return (
    <>
      <tbody>
      <TableRow className="border-b border-muted hover:bg-row-hover">
        <TableCell className="px-5 py-3.5 whitespace-normal">
          <BatchToggle batch={batch} open={open} onToggle={onToggle} controls={contentId}>
            <BatchLabel batch={batch} />
          </BatchToggle>
        </TableCell>
        <TableCell className="px-5 py-3.5 text-small whitespace-normal text-muted-foreground">
          <TemplateName templateId={batch.templateId} templateName={templateName} version={batch.templateVersion} />
        </TableCell>
        <TableCell className="px-5 py-3.5 text-small text-muted-foreground">
          <time dateTime={batch.createdAt.toISOString()}>{shortDateTime(batch.createdAt)}</time>
        </TableCell>
        <TableCell className="px-5 py-3.5 font-mono text-caption tabular-nums text-muted-foreground">
          {formatBytes(batch.size)}
        </TableCell>
        <TableCell className="px-5 py-3.5 text-right">
          <span className="inline-flex items-center gap-1.5">
            <DownloadButton
              busy={downloads.saving === `batch:${batch.id}`}
              onClick={() => void downloads.batch(batch.id)}
              label={`Baixar o lote ${batch.name} como ZIP`}
              zip
            />
            <DeleteBatch batch={batch} />
          </span>
        </TableCell>
      </TableRow>
      </tbody>
      {open && <BatchDocumentRows id={contentId} batch={batch} downloads={downloads} />}
    </>
  );
}

/** The documents of an open batch, as indented rows, a page at a time. */
function BatchDocumentRows({
  id,
  batch,
  downloads,
}: {
  readonly id: string;
  readonly batch: Batch;
  readonly downloads: Downloads;
}) {
  const query = useInfiniteQuery(batchDocumentsQuery(batch.id));
  const pages = query.data?.pages ?? [];
  const failed = pages.find((p) => !p.ok);
  const items = pages.flatMap((p) => (p.ok ? p.value.items : []));

  const note = (content: ReactNode) => (
    <TableRow className="border-b border-muted bg-raised/40 hover:bg-raised/40">
      <TableCell colSpan={5} className="py-3 pr-5 pl-14 text-small text-muted-foreground">
        {content}
      </TableCell>
    </TableRow>
  );

  return (
    // A body of its own, so aria-controls on the toggle names something real.
    <tbody id={id} aria-label={`Documentos do lote ${batch.name}`}>
      {query.isPending
        ? note("Carregando documentos…")
        : failed !== undefined && !failed.ok
          ? note(<span role="alert">{summaryOf(failed.failure) ?? "Não foi possível carregar."}</span>)
          : items.length === 0
            ? note("Este lote ainda não tem documentos.")
            : items.map((item) => (
                <DocumentRow key={item.document.id} item={item} downloads={downloads} nested />
              ))}
      {query.hasNextPage &&
        note(
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? "Carregando…" : "Carregar mais documentos"}
          </Button>,
        )}
    </tbody>
  );
}

/** A batch as a card, for screens too narrow for the table. */
function BatchCard({
  batch,
  templateName,
  open,
  onToggle,
  downloads,
}: {
  readonly batch: Batch;
  readonly templateName: string | null;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly downloads: Downloads;
}) {
  const contentId = `batch-${batch.id}-cards`;

  return (
    <li className="flex flex-col gap-2.5 rounded-lg border border-docs/30 bg-card px-4 py-3.5">
      <BatchToggle batch={batch} open={open} onToggle={onToggle} controls={contentId}>
        <BatchLabel batch={batch} />
      </BatchToggle>
      <span className="text-small text-muted-foreground">
        <TemplateName templateId={batch.templateId} templateName={templateName} version={batch.templateVersion} />
      </span>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <time dateTime={batch.createdAt.toISOString()}>{shortDateTime(batch.createdAt)}</time>
        <span className="font-mono tabular-nums">{formatBytes(batch.size)}</span>
      </span>
      <span className="flex items-center gap-2">
        <DownloadButton
          busy={downloads.saving === `batch:${batch.id}`}
          onClick={() => void downloads.batch(batch.id)}
          label={`Baixar o lote ${batch.name} como ZIP`}
          zip
          className="h-10"
        />
        <DeleteBatch batch={batch} />
      </span>
      {open && <BatchDocumentCards id={contentId} batch={batch} downloads={downloads} />}
    </li>
  );
}

function BatchDocumentCards({
  id,
  batch,
  downloads,
}: {
  readonly id: string;
  readonly batch: Batch;
  readonly downloads: Downloads;
}) {
  const query = useInfiniteQuery(batchDocumentsQuery(batch.id));
  const pages = query.data?.pages ?? [];
  const failed = pages.find((p) => !p.ok);
  const items = pages.flatMap((p) => (p.ok ? p.value.items : []));

  return (
    <div id={id} className="flex flex-col gap-2 pt-1">
      {query.isPending ? (
        <p className="text-small text-muted-foreground">Carregando documentos…</p>
      ) : failed !== undefined && !failed.ok ? (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(failed.failure) ?? "Não foi possível carregar."}
        </p>
      ) : items.length === 0 ? (
        <p className="text-small text-muted-foreground">Este lote ainda não tem documentos.</p>
      ) : (
        <ul aria-label={`Documentos do lote ${batch.name}`} className="flex flex-col gap-2">
          {items.map((item) => (
            <DocumentCard key={item.document.id} item={item} downloads={downloads} nested />
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
          className="h-10 self-start"
        >
          {query.isFetchingNextPage ? "Carregando…" : "Carregar mais documentos"}
        </Button>
      )}
    </div>
  );
}

/**
 * A trash button behind a confirmation that says what goes with it.
 *
 * The dialog is mounted only once asked for: Base UI renders its root through
 * a portal, which does not survive hydration here.
 */
function DeleteButton({
  label,
  title,
  description,
  confirm,
  run,
  onDeleted,
}: {
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly run: () => Promise<Result<null>>;
  readonly onDeleted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const remove = useMutation({ mutationFn: run });

  async function onConfirm() {
    setFailure(null);
    const result = await remove.mutateAsync();
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setOpen(false);
    await onDeleted();
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        onClick={() => {
          setFailure(null);
          setMounted(true);
          setOpen(true);
        }}
        // 40px on a phone: an icon-only button is the easiest target to miss.
        className="text-muted-foreground hover:text-destructive max-md:size-10"
      >
        <IconTrash aria-hidden="true" />
      </Button>

      {mounted && (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription>{description}</AlertDialogDescription>
            </AlertDialogHeader>

            {failure && (
              <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive">
                <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                <span>{summaryOf(failure)}</span>
              </p>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={onConfirm}>
                {remove.isPending ? "Excluindo…" : confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

/** Deleting a batch: every document in it goes too. */
function DeleteBatch({ batch }: { readonly batch: Batch }) {
  const queryClient = useQueryClient();
  return (
    <DeleteButton
      label={`Excluir o lote ${batch.name}`}
      title={`Excluir o lote “${batch.name}”?`}
      description={
        batch.documents === 0
          ? "O lote está vazio e sai do histórico."
          : `Os ${batchCount(batch.documents)} deste lote são apagados junto, com os valores preenchidos neles. Não há como desfazer.`
      }
      confirm="Excluir lote"
      run={() => deleteBatch({ data: batch.id })}
      onDeleted={async () => {
        queryClient.removeQueries({ queryKey: queryKeys.batchDocuments(batch.id) });
        await invalidateAfter(queryClient, "batchChanged");
      }}
    />
  );
}

/**
 * Deleting one document, loose or inside a batch. The values filled into it go
 * with it; the template it came from is untouched.
 */
function DeleteDocument({ id, name }: { readonly id: string; readonly name: string }) {
  const queryClient = useQueryClient();
  return (
    <DeleteButton
      label={`Excluir ${name}`}
      title={`Excluir “${name}”?`}
      description="O documento e os valores preenchidos nele são apagados. O modelo não muda. Não há como desfazer."
      confirm="Excluir documento"
      run={() => deleteDocument({ data: id })}
      onDeleted={() => invalidateAfter(queryClient, "documentDeleted")}
    />
  );
}
