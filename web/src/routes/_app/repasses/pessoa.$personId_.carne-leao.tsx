import { createFileRoute, Link } from "@tanstack/react-router";
import { IconArrowLeft, IconChevronLeft, IconChevronRight, IconDownload, IconPrinter } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/domain/contract";
import {
  incomeReportCsv,
  isEmptyMonth,
  monthName,
  reportYear,
  type IncomeFigures,
  type IncomeMonth,
  type IncomeReport,
} from "@/domain/income-report";
import { todayInSaoPaulo } from "@/domain/rent";
import { cn } from "@/lib/utils";
import { incomeReport } from "@/server/payouts";

export const Route = createFileRoute("/_app/repasses/pessoa/$personId_/carne-leao")({
  validateSearch: (search: Record<string, unknown>): { ano?: number | undefined } => ({ ano: reportYear(search["ano"]) }),
  loaderDeps: ({ search }) => ({ year: search.ano ?? Number(todayInSaoPaulo().slice(0, 4)) }),
  loader: ({ params, deps }) => incomeReport({ data: { personId: params.personId, year: deps.year } }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.ok ? `Carnê-leão ${loaderData.value.year}, ${loaderData.value.person.name}` : "Carnê-leão"} | Imobiliary`,
      },
    ],
  }),
  component: IncomeReportPage,
});

/**
 * An individual owner's receipts through the office in a year, for the
 * carnê-leão. The sums come from the ledger, on the day the office received
 * each payment; the page computes no tax. Printed on a light sheet like the
 * receipts, and downloadable as a spreadsheet for the accountant.
 */
function IncomeReportPage() {
  const result = Route.useLoaderData();
  const { personId } = Route.useParams();

  const back = (
    <Link
      to="/repasses/pessoa/$personId"
      params={{ personId }}
      className="flex w-fit items-center gap-1 text-small text-muted-foreground hover:text-foreground print:hidden"
    >
      <IconArrowLeft aria-hidden="true" className="size-4" />
      Repasses da pessoa
    </Link>
  );

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {result.failure.kind === "validation"
            ? result.failure.fields[0]?.message
            : summaryOf(result.failure, { not_found: "Esta pessoa não existe ou foi removida." })}
        </p>
      </div>
    );
  }

  const report = result.value;

  function download() {
    const blob = new Blob([incomeReportCsv(report)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `carne-leao-${report.year}-${report.person.name.normalize("NFD").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase()}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {back}
        <nav aria-label="Ano" className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Ano ${report.year - 1}`}
            nativeButton={false}
            render={<Link to="/repasses/pessoa/$personId/carne-leao" params={{ personId }} search={{ ano: report.year - 1 }} />}
          >
            <IconChevronLeft aria-hidden="true" />
          </Button>
          <span className="min-w-12 text-center text-small font-medium tabular-nums">{report.year}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Ano ${report.year + 1}`}
            nativeButton={false}
            render={<Link to="/repasses/pessoa/$personId/carne-leao" params={{ personId }} search={{ ano: report.year + 1 }} />}
          >
            <IconChevronRight aria-hidden="true" />
          </Button>
        </nav>
        <Button variant="secondary" onClick={download}>
          <IconDownload data-icon="inline-start" aria-hidden="true" />
          Baixar planilha
        </Button>
        <Button onClick={() => window.print()}>
          <IconPrinter data-icon="inline-start" aria-hidden="true" />
          Imprimir
        </Button>
      </div>

      {/* A light theme on the sheet itself: what prints is black on white. */}
      <article
        data-scheme="light"
        className="flex flex-col gap-5 rounded-lg border border-border bg-background px-6 py-8 font-reading text-foreground print:rounded-none print:border-0 print:px-0 print:py-0"
      >
        <header className="flex flex-col gap-1">
          <h1 className="text-title font-semibold">Relatório para carnê-leão, {report.year}</h1>
          <p className="text-small">{report.person.name}</p>
          <p className="text-caption text-muted-foreground">
            Valores recebidos pelo escritório em cada mês, pela data do recebimento. Aluguel pago por pessoa física entra no
            carnê-leão; o pago por empresa é informado por ela, com o IRRF que reteve. Este relatório soma os lançamentos e
            não calcula imposto: a apuração e o que pode ser deduzido ficam com o contador.
          </p>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-caption tabular-nums">
            <thead>
              <tr className="text-left">
                <th scope="col" rowSpan={2} className="border-b border-border py-1.5 pr-3 align-bottom font-semibold">
                  Mês
                </th>
                <th scope="colgroup" colSpan={4} className="border-b border-border px-2 py-1.5 text-center font-semibold">
                  Locatário pessoa física (carnê-leão)
                </th>
                <th scope="colgroup" colSpan={5} className="border-b border-border px-2 py-1.5 text-center font-semibold">
                  Locatário empresa (retido na fonte)
                </th>
                <th scope="col" rowSpan={2} className="border-b border-border py-1.5 pl-2 text-right align-bottom font-semibold">
                  Débitos lançados
                </th>
              </tr>
              <tr className="text-right text-muted-foreground">
                {[...FIGURE_HEADERS, ...FIGURE_HEADERS, "IRRF retido"].map((h, i) => (
                  <th key={i} scope="col" className="border-b border-border px-2 py-1 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.months.map((m) => (
                <MonthRow key={m.month} label={monthName(m.month)} month={m} muted={isEmptyMonth(m)} />
              ))}
            </tbody>
            <tfoot>
              <MonthRow label="Total" month={report.total} total />
            </tfoot>
          </table>
        </div>

        {report.total.credits !== "0.00" && (
          <p className="text-caption text-muted-foreground">Créditos lançados no ano: {formatMoney(report.total.credits)}.</p>
        )}
        <p className="text-caption text-muted-foreground">
          Cobranças do proprietário são as que o locatário paga e o escritório repassa a ele, como o IPTU. Débitos são
          despesas que o escritório pagou e descontou nos repasses.
        </p>
      </article>
    </div>
  );
}

const FIGURE_HEADERS = ["Aluguel", "Multa e juros", "Cobranças", "Taxa de administração"] as const;

function figures(f: IncomeFigures): readonly string[] {
  return [f.rent, f.lateFee, f.charges, f.adminFee];
}

function MonthRow({
  label,
  month,
  muted = false,
  total = false,
}: {
  readonly label: string;
  readonly month: IncomeMonth;
  readonly muted?: boolean;
  readonly total?: boolean;
}) {
  const cells = [...figures(month.individual), ...figures(month.company), month.company.incomeTax, month.debits];
  return (
    <tr className={cn("border-b border-border", muted && "text-muted-foreground", total && "font-semibold")}>
      <th scope="row" className="py-1.5 pr-3 text-left font-[inherit]">
        {label}
      </th>
      {cells.map((value, i) => (
        <td key={i} className="px-2 py-1.5 text-right">
          {value === "0.00" ? "-" : formatMoney(value).replace("R$ ", "")}
        </td>
      ))}
    </tr>
  );
}
