import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconSearch } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { PaymentDialog, RentStatusBadge, rentStatusNote } from "@/components/rents/payment-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate, formatMoney } from "@/domain/contract";
import { addressLine } from "@/domain/property";
import { monthLabel, monthRange, todayInSaoPaulo, type RentSummary } from "@/domain/rent";
import { cn } from "@/lib/utils";
import { listRents } from "@/server/rents";

type StatusFilter = "em-atraso" | "em-aberto" | "pagos";

type RentsSearch = { q?: string; situacao?: StatusFilter; mes?: string };

const STATUS_OF: Record<StatusFilter, "overdue" | "open" | "paid"> = {
  "em-atraso": "overdue",
  "em-aberto": "open",
  pagos: "paid",
};

export const Route = createFileRoute("/_app/alugueis/")({
  validateSearch: (search: Record<string, unknown>): RentsSearch => {
    const out: RentsSearch = {};
    if (typeof search["q"] === "string" && search["q"] !== "") out.q = search["q"];
    if (typeof search["situacao"] === "string" && search["situacao"] in STATUS_OF) {
      out.situacao = search["situacao"] as StatusFilter;
    }
    if (typeof search["mes"] === "string" && monthRange(search["mes"]) !== null) out.mes = search["mes"];
    return out;
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => listRents({ data: queryOf(deps) }),
  head: () => ({ meta: [{ title: "Aluguéis | Imobiliary" }] }),
  component: RentsPage,
});

/**
 * Overdue rents are listed whatever their month, since the point is to see
 * them all; the other filters look at one month of due days, the current one
 * unless another is chosen.
 */
function queryOf(search: RentsSearch, cursor?: string) {
  const month = search.mes ?? todayInSaoPaulo().slice(0, 7);
  const range = monthRange(month);
  const overdue = search.situacao === "em-atraso";
  return {
    q: search.q,
    status: search.situacao === undefined ? undefined : STATUS_OF[search.situacao],
    dueFrom: overdue ? undefined : range?.from,
    dueTo: overdue ? undefined : range?.to,
    cursor,
  };
}

function withSearch<K extends keyof RentsSearch>(prev: RentsSearch, key: K, value: RentsSearch[K] | undefined): RentsSearch {
  const next: RentsSearch = { ...prev };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

const filters: readonly { readonly label: string; readonly value: StatusFilter | undefined }[] = [
  { label: "Todos do mês", value: undefined },
  { label: "Em aberto no mês", value: "em-aberto" },
  { label: "Pagos no mês", value: "pagos" },
  { label: "Todos em atraso", value: "em-atraso" },
];

function RentsPage() {
  const search = Route.useSearch();
  const result = Route.useLoaderData();
  const navigate = useNavigate({ from: Route.fullPath });
  const today = todayInSaoPaulo();
  const month = search.mes ?? today.slice(0, 7);

  const [typed, setTyped] = useState(search.q ?? "");
  const [extra, setExtra] = useState<readonly RentSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(result.ok ? result.value.nextCursor : null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setExtra([]);
    setCursor(result.ok ? result.value.nextCursor : null);
  }, [result]);

  useEffect(() => {
    const next = typed.trim();
    if (next === (search.q ?? "")) return;
    const timer = setTimeout(() => {
      void navigate({ search: (prev) => withSearch(prev, "q", next === "" ? undefined : next), replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [typed, search.q, navigate]);

  const rents = result.ok ? [...result.value.rents, ...extra] : [];

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    const next = await listRents({ data: queryOf(search, cursor) });
    setLoadingMore(false);
    if (next.ok) {
      setExtra((current) => [...current, ...next.value.rents]);
      setCursor(next.value.nextCursor);
    }
  }

  const overdueView = search.situacao === "em-atraso";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Aluguéis</h1>
        <p className="font-reading text-muted-foreground">
          {overdueView ? "Tudo o que venceu e não foi pago, do mais antigo ao mais recente." : `Vencimentos de ${monthLabel(month)}.`}
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative min-w-60 flex-1">
            <IconSearch
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
            />
            <Input
              type="search"
              aria-label="Buscar pelo número do contrato, endereço ou nome de uma parte"
              placeholder="Buscar pelo contrato, endereço ou nome"
              className="pl-9"
              value={typed}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setTyped(next);
              }}
            />
          </div>
          {!overdueView && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mes">Mês do vencimento</Label>
              <Input
                id="mes"
                type="month"
                className="w-44"
                value={month}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  if (monthRange(next) === null) return;
                  void navigate({
                    search: (prev) => withSearch(prev, "mes", next === today.slice(0, 7) ? undefined : next),
                    replace: true,
                  });
                }}
              />
            </div>
          )}
        </div>
        <nav aria-label="Filtrar por situação" className="flex flex-wrap gap-2">
          {filters.map((filter) => (
            <Link
              key={filter.label}
              from={Route.fullPath}
              search={(prev) => withSearch(prev, "situacao", filter.value)}
              replace
              aria-current={search.situacao === filter.value ? "page" : undefined}
              className={cn(
                "rounded-md border px-3 py-1.5 text-small font-medium",
                search.situacao === filter.value
                  ? "border-primary-text bg-muted text-foreground"
                  : "border-border text-muted-foreground hover:bg-row-hover",
              )}
            >
              {filter.label}
            </Link>
          ))}
        </nav>
      </div>

      {!result.ok ? (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(result.failure) ?? "Não foi possível carregar os aluguéis agora."}
        </p>
      ) : rents.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-5 py-6">
          <p className="font-medium">
            {overdueView ? "Nenhum aluguel em atraso." : `Nenhum aluguel encontrado em ${monthLabel(month)}.`}
          </p>
          <p className="font-reading text-small text-muted-foreground">
            Os aluguéis são gerados com cada contrato, para todo o prazo.
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
            {rents.map((rent) => (
              <li key={rent.id} className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Link
                  to="/alugueis/$rentId"
                  params={{ rentId: rent.id }}
                  className="flex min-w-0 grow basis-full sm:basis-0 flex-col gap-0.5 hover:underline"
                >
                  <span className="truncate font-medium">{addressLine(rent.contract.address)}</span>
                  <span className="truncate text-caption text-muted-foreground">{rent.contract.tenantNames.join(", ")}</span>
                  <span className="truncate text-caption text-faint tabular-nums">
                    Nº {rent.contract.registry} · parcela {rent.sequence} · vence {formatDate(rent.dueOn)}
                  </span>
                </Link>
                <span className="flex flex-col items-end gap-1 tabular-nums">
                  <span className="font-medium">{formatMoney(rent.amountPaid ?? rent.due)}</span>
                  <span className="text-caption text-muted-foreground">{rentStatusNote(rent, today)}</span>
                </span>
                <RentStatusBadge status={rent.status} />
                {rent.status !== "paid" && <PaymentDialog rent={rent} />}
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
