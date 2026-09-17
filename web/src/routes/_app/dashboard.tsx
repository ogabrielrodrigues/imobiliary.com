import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { IconArrowRight } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { PaymentDialog, rentStatusNote } from "@/components/rents/payment-dialog";
import { formatDate, formatMoney } from "@/domain/contract";
import { addressLine } from "@/domain/property";
import { daysBetween, monthLabel, type ContractDeadline, type Dashboard, type RentSummary } from "@/domain/rent";
import { getDashboard } from "@/server/rents";

export const Route = createFileRoute("/_app/dashboard")({
  loader: () => getDashboard(),
  head: () => ({ meta: [{ title: "Dashboard | Imobiliary" }] }),
  component: DashboardPage,
});

/**
 * The office's day: what is due today and overdue, the month's receipts, the
 * portfolio and the deadlines coming up. Every figure comes from the API as of
 * today in São Paulo.
 */
function DashboardPage() {
  const result = Route.useLoaderData();

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Dashboard</h1>
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(result.failure) ?? "Não foi possível carregar os números agora."}
        </p>
      </div>
    );
  }

  const d = result.value;
  const empty = d.portfolio.properties === 0 && d.portfolio.activeContracts === 0 && d.month.expectedCount === 0;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Dashboard</h1>
        <p className="font-reading text-muted-foreground">
          Hoje, {formatDate(d.today)}. Números de {monthLabel(d.today.slice(0, 7))}.
        </p>
      </header>

      {empty ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border px-5 py-6">
          <p className="font-medium">Ainda não há imóveis nem contratos.</p>
          <p className="font-reading text-small text-muted-foreground">
            Cadastre as pessoas e os imóveis, depois registre o contrato. Os aluguéis e estes números aparecem a partir
            dele.
          </p>
        </div>
      ) : (
        <>
          <MonthCards d={d} />

          <div className="grid gap-6 lg:grid-cols-2">
            <RentTable
              title="Vencem hoje"
              empty="Nenhum aluguel em aberto vence hoje."
              rents={d.dueToday}
              today={d.today}
              more={{ to: "/alugueis", label: "Ver o mês" }}
            />
            <RentTable
              title={`Em atraso${d.overdue.count > d.overdueRents.length ? ` (${d.overdueRents.length} de ${d.overdue.count})` : ""}`}
              empty="Nenhum aluguel em atraso."
              rents={d.overdueRents}
              today={d.today}
              more={{ to: "/alugueis", search: { situacao: "em-atraso" }, label: "Ver todos em atraso" }}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Deadlines
              title="Contratos que terminam em 60 dias"
              empty="Nenhum contrato termina nos próximos 60 dias."
              items={d.expiring}
              today={d.today}
              verb="termina"
            />
            <Deadlines
              title="Reajustes a fazer"
              empty="Nenhum contrato completa doze meses sem reajuste nos próximos 30 dias."
              items={d.adjustments}
              today={d.today}
              verb="completa doze meses"
            />
          </div>
        </>
      )}
    </div>
  );
}

function MonthCards({ d }: { readonly d: Dashboard }) {
  const { month, overdue, portfolio } = d;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Recebido no mês" value={formatMoney(month.received)}>
        {month.receivedCount === 1 ? "1 pagamento" : `${month.receivedCount} pagamentos`}
      </Card>
      <Card label="Em aberto no mês" value={formatMoney(month.open)}>
        {month.openCount === 1 ? "1 aluguel" : `${month.openCount} aluguéis`} de {formatMoney(month.expected)} previstos
      </Card>
      <Card label="Em atraso" value={formatMoney(overdue.amount)} tone={overdue.count > 0 ? "alert" : undefined}>
        {overdue.count === 1 ? "1 aluguel" : `${overdue.count} aluguéis`}, sem multa e juros
      </Card>
      <Card label="Taxa de administração do mês" value={formatMoney(month.officeFee)}>
        sobre aluguéis e cobranças recebidos, sem multa e juros
      </Card>
      <Card label="Imóveis" value={String(portfolio.properties)}>
        {portfolio.leasedProperties === 1 ? "1 locado" : `${portfolio.leasedProperties} locados`}
      </Card>
      <Card label="Contratos vigentes" value={String(portfolio.activeContracts)}>
        {formatMoney(portfolio.rentRoll)} em aluguéis por mês
      </Card>
    </div>
  );
}

function Card({
  label,
  value,
  tone,
  children,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "alert" | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3">
      <span className="font-mono text-micro tracking-[0.1em] text-faint uppercase">{label}</span>
      <span className={tone === "alert" ? "font-reading text-title font-semibold text-destructive-soft tabular-nums" : "font-reading text-title font-semibold tabular-nums"}>
        {value}
      </span>
      <span className="text-caption text-muted-foreground">{children}</span>
    </div>
  );
}

function Panel({ title, action, children }: { readonly title: string; readonly action?: ReactNode; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function RentTable({
  title,
  empty,
  rents,
  today,
  more,
}: {
  readonly title: string;
  readonly empty: string;
  readonly rents: readonly RentSummary[];
  readonly today: string;
  readonly more: { readonly to: "/alugueis"; readonly search?: { readonly situacao: "em-atraso" }; readonly label: string };
}) {
  return (
    <Panel
      title={title}
      action={
        <Link
          to={more.to}
          {...(more.search ? { search: more.search } : {})}
          className="ml-auto flex items-center gap-1 text-small text-muted-foreground hover:text-foreground"
        >
          {more.label}
          <IconArrowRight aria-hidden="true" className="size-4" />
        </Link>
      }
    >
      {rents.length === 0 ? (
        <p className="text-small text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rents.map((rent) => (
            <li key={rent.id} className="flex flex-wrap items-center gap-3 py-2">
              <Link to="/alugueis/$rentId" params={{ rentId: rent.id }} className="flex min-w-0 grow basis-full sm:basis-0 flex-col hover:underline">
                <span className="truncate text-small font-medium">{addressLine(rent.contract.address)}</span>
                <span className="truncate text-caption text-muted-foreground">
                  {rent.contract.tenantNames.join(", ")} · {rentStatusNote(rent, today)}
                </span>
              </Link>
              <span className="text-small tabular-nums">{formatMoney(rent.due)}</span>
              <PaymentDialog rent={rent} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Deadlines({
  title,
  empty,
  items,
  today,
  verb,
}: {
  readonly title: string;
  readonly empty: string;
  readonly items: readonly ContractDeadline[];
  readonly today: string;
  readonly verb: string;
}) {
  return (
    <Panel title={title}>
      {items.length === 0 ? (
        <p className="text-small text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((item) => {
            const days = daysBetween(today, item.on);
            const when = days < 0 ? `desde ${formatDate(item.on)}` : days === 0 ? "hoje" : `em ${formatDate(item.on)}`;
            return (
              <li key={item.contractId} className="py-2">
                <Link
                  to="/contratos/$contractId"
                  params={{ contractId: item.contractId }}
                  className="flex flex-col hover:underline"
                >
                  <span className="truncate text-small font-medium">{addressLine(item.address)}</span>
                  <span className="text-caption text-muted-foreground">
                    Contrato {item.registry} {days < 0 ? `${verb === "termina" ? "terminou" : "completou doze meses"} ${when}` : `${verb} ${when}`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
