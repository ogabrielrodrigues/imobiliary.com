import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";

import { summaryOf } from "@/application/result";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney } from "@/domain/contract";
import { formatSigned, methodLabel, parseSigned, type Payout } from "@/domain/payout";
import { payoutsOverview } from "@/server/payouts";

export const Route = createFileRoute("/_app/repasses/")({
  loader: () => payoutsOverview({ data: undefined }),
  head: () => ({ meta: [{ title: "Repasses | Imobiliary" }] }),
  component: PayoutsPage,
});

/**
 * Who the office owes, and what it already paid out.
 *
 * A balance is written by each rent received, for each landlord, and closed
 * by a payout the office records once it transferred.
 */
function PayoutsPage() {
  const result = Route.useLoaderData();
  const [extra, setExtra] = useState<readonly Payout[]>([]);
  const [cursor, setCursor] = useState<string | null>(result.ok ? result.value.recent.nextCursor : null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setExtra([]);
    setCursor(result.ok ? result.value.recent.nextCursor : null);
  }, [result]);

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    const next = await payoutsOverview({ data: cursor });
    setLoadingMore(false);
    if (next.ok) {
      setExtra((current) => [...current, ...next.value.recent.payouts]);
      setCursor(next.value.recent.nextCursor);
    }
  }

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Repasses</h1>
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(result.failure) ?? "Não foi possível carregar os repasses agora."}
        </p>
      </div>
    );
  }

  const { balances, recent } = result.value;
  const payouts = [...recent.payouts, ...extra];
  const owed = balances.reduce((sum, b) => sum + Math.max(parseSigned(b.pending) ?? 0, 0), 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Repasses</h1>
        <p className="font-reading text-muted-foreground">
          Cada aluguel recebido entra no saldo de cada locador, já sem a taxa de administração. Registre o repasse
          depois de transferir: a plataforma não movimenta dinheiro.
        </p>
      </header>

      <section aria-labelledby="balances-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="balances-title" className="text-sm font-semibold">
            A repassar
          </h2>
          {balances.length > 0 && (
            <span className="text-small tabular-nums text-muted-foreground">Total: {formatSigned(owed)}</span>
          )}
        </div>
        {balances.length === 0 ? (
          <div className="flex flex-col items-start gap-1 rounded-lg border border-dashed border-border px-5 py-6">
            <p className="font-medium">Nenhum saldo a repassar.</p>
            <p className="font-reading text-small text-muted-foreground">
              O saldo aparece aqui quando um aluguel é registrado como pago.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
            {balances.map((b) => {
              const cents = parseSigned(b.pending) ?? 0;
              return (
                <li key={b.person.id} className="border-b border-border last:border-b-0">
                  <Link
                    to="/repasses/pessoa/$personId"
                    params={{ personId: b.person.id }}
                    className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-row-hover"
                  >
                    <span className="flex min-w-0 grow basis-full flex-col gap-0.5 sm:basis-0">
                      <span className="truncate font-medium">{b.person.name}</span>
                      <span className="text-caption text-muted-foreground">
                        {b.lines === 1 ? "1 lançamento" : `${b.lines} lançamentos`} desde {formatDate(b.oldestOn)}
                      </span>
                    </span>
                    <span className={cents < 0 ? "font-medium tabular-nums text-destructive-soft" : "font-medium tabular-nums"}>
                      {formatSigned(cents)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="payouts-title" className="flex flex-col gap-3">
        <h2 id="payouts-title" className="text-sm font-semibold">
          Repasses registrados
        </h2>
        {payouts.length === 0 ? (
          <p className="text-small text-muted-foreground">Nenhum repasse registrado ainda.</p>
        ) : (
          <>
            <ul className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
              {payouts.map((p) => (
                <li key={p.id} className="border-b border-border last:border-b-0">
                  <Link
                    to="/repasses/$payoutId"
                    params={{ payoutId: p.id }}
                    className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-row-hover"
                  >
                    <span className="flex min-w-0 grow basis-full flex-col gap-0.5 sm:basis-0">
                      <span className="truncate font-medium">{p.person.name}</span>
                      <span className="text-caption text-muted-foreground tabular-nums">
                        Nº {p.number} · {formatDate(p.paidOn)}
                        {p.method !== "" && ` · ${methodLabel(p.method)}`}
                      </span>
                    </span>
                    <span className="font-medium tabular-nums">{formatMoney(p.total)}</span>
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
      </section>
    </div>
  );
}
