import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconFileDescription, IconPlus, IconSearch } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { ContractStatusBadge } from "@/components/contracts/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, formatMoney, type ContractStatus, type ContractSummary } from "@/domain/contract";
import { addressLine } from "@/domain/property";
import { cn } from "@/lib/utils";
import { listContracts } from "@/server/contracts";

type StatusFilter = "a-iniciar" | "vigentes" | "vencidos" | "rescindidos";

const STATUS_OF: Record<StatusFilter, ContractStatus> = {
  "a-iniciar": "upcoming",
  vigentes: "active",
  vencidos: "expired",
  rescindidos: "terminated",
};

type ContractsSearch = {
  q?: string | undefined;
  situacao?: StatusFilter | undefined;
  imovel?: string | undefined;
  pessoa?: string | undefined;
};

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

export const Route = createFileRoute("/_app/contratos/")({
  validateSearch: (search: Record<string, unknown>): ContractsSearch => {
    const situacao = text(search["situacao"]);
    return {
      q: text(search["q"]),
      situacao: situacao !== undefined && situacao in STATUS_OF ? (situacao as StatusFilter) : undefined,
      imovel: text(search["imovel"]),
      pessoa: text(search["pessoa"]),
    };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    listContracts({
      data: {
        q: deps.q,
        status: deps.situacao === undefined ? undefined : STATUS_OF[deps.situacao],
        propertyId: deps.imovel,
        personId: deps.pessoa,
      },
    }),
  head: () => ({ meta: [{ title: "Contratos | Imobiliary" }] }),
  component: ContractsPage,
});

/** Sets or removes one search key; an absent key, never an undefined one. */
function withSearch<K extends keyof ContractsSearch>(
  prev: ContractsSearch,
  key: K,
  value: ContractsSearch[K] | undefined,
): ContractsSearch {
  const next: ContractsSearch = { ...prev };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

const filters: readonly { readonly label: string; readonly value: StatusFilter | undefined }[] = [
  { label: "Todos", value: undefined },
  { label: "Vigentes", value: "vigentes" },
  { label: "A iniciar", value: "a-iniciar" },
  { label: "Vencidos", value: "vencidos" },
  { label: "Rescindidos", value: "rescindidos" },
];

/**
 * The office's contracts, the most recent start first. The search matches the
 * contract number, the street or the name of any party.
 */
function ContractsPage() {
  const search = Route.useSearch();
  const { q, situacao, imovel, pessoa } = search;
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });

  const [typed, setTyped] = useState(q ?? "");
  const [extra, setExtra] = useState<readonly ContractSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(result.ok ? result.value.nextCursor : null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setExtra([]);
    setCursor(result.ok ? result.value.nextCursor : null);
  }, [result]);

  useEffect(() => {
    const next = typed.trim();
    if (next === (q ?? "")) return;
    const timer = setTimeout(() => {
      void navigate({ search: (prev) => withSearch(prev, "q", next === "" ? undefined : next), replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [typed, q, navigate]);

  const contracts = result.ok ? [...result.value.contracts, ...extra] : [];
  const filtered = q !== undefined || situacao !== undefined || imovel !== undefined || pessoa !== undefined;

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    const next = await listContracts({
      data: {
        q,
        status: situacao === undefined ? undefined : STATUS_OF[situacao],
        propertyId: imovel,
        personId: pessoa,
        cursor,
      },
    });
    setLoadingMore(false);
    if (next.ok) {
      setExtra((current) => [...current, ...next.value.contracts]);
      setCursor(next.value.nextCursor);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Contratos</h1>
        <Button className="ml-auto" nativeButton={false} render={<Link to="/contratos/novo" />}>
          <IconPlus data-icon="inline-start" aria-hidden="true" />
          Novo contrato
        </Button>
      </header>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <IconSearch
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          />
          <Input
            type="search"
            aria-label="Buscar contratos pelo número, endereço ou nome de uma parte"
            placeholder="Buscar pelo número, endereço ou nome de uma parte"
            className="pl-9"
            value={typed}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setTyped(next);
            }}
          />
        </div>
        <nav aria-label="Filtrar por situação" className="flex flex-wrap gap-2">
          {filters.map((filter) => (
            <Link
              key={filter.label}
              from={Route.fullPath}
              search={(prev) => withSearch(prev, "situacao", filter.value)}
              replace
              aria-current={situacao === filter.value ? "page" : undefined}
              className={cn(
                "rounded-md border px-3 py-1.5 text-small font-medium",
                situacao === filter.value
                  ? "border-primary-text bg-muted text-foreground"
                  : "border-border text-muted-foreground hover:bg-row-hover",
              )}
            >
              {filter.label}
            </Link>
          ))}
        </nav>
        {(imovel !== undefined || pessoa !== undefined) && (
          <p className="text-small text-muted-foreground">
            {imovel !== undefined ? "Mostrando os contratos de um imóvel." : "Mostrando os contratos de uma pessoa."}{" "}
            <Link
              from={Route.fullPath}
              search={(prev) => withSearch(withSearch(prev, "imovel", undefined), "pessoa", undefined)}
              className="underline hover:text-foreground"
            >
              Ver todos
            </Link>
          </p>
        )}
      </div>

      {!result.ok ? (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(result.failure) ?? "Não foi possível carregar os contratos agora."}
        </p>
      ) : contracts.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-5 py-6">
          <p className="font-medium">{filtered ? "Nenhum contrato encontrado." : "Nenhum contrato cadastrado ainda."}</p>
          <p className="font-reading text-small text-muted-foreground">
            {q !== undefined
              ? "Busque por outra parte do endereço, pelo número ou pelo nome de uma parte."
              : filtered
                ? "Escolha outra situação ou veja todos os contratos."
              : "Com o imóvel e as pessoas cadastrados, registre o contrato e os aluguéis são gerados para todo o prazo."}
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
            {contracts.map((contract) => (
              <li key={contract.id} className="border-b border-border last:border-b-0">
                <Link
                  to="/contratos/$contractId"
                  params={{ contractId: contract.id }}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-row-hover focus-visible:bg-row-hover focus-visible:outline-none"
                >
                  <IconFileDescription aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-faint" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-medium">{addressLine(contract.address)}</span>
                    <span className="truncate text-caption text-muted-foreground">
                      {contract.tenantNames.join(", ")}
                    </span>
                    <span className="truncate text-caption text-faint tabular-nums">
                      Nº {contract.registry} · {formatDate(contract.startsOn)} a{" "}
                      {formatDate(contract.terminatedOn ?? contract.expiresOn)} · {formatMoney(contract.currentRent)}
                    </span>
                  </span>
                  <ContractStatusBadge status={contract.status} />
                </Link>
              </li>
            ))}
          </ul>
          {cursor !== null && (
            <Button variant="secondary" className="self-center" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Carregando..." : "Mostrar mais"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
