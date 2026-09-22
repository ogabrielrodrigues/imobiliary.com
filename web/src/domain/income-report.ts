/**
 * The carnê-leão report (PLANO-PENDENCIAS.md §3): an individual owner's
 * receipts through the office, month by month, on the day the office received
 * them. Mirrors `internal/usecase/income_report.go`: the API adds up the
 * ledger, and this module only labels the sums and writes them as a
 * spreadsheet for the accountant.
 */

import { parseMoney } from "./contract.ts";
import type { PersonRef } from "./payout.ts";

export interface IncomeFigures {
  readonly rent: string;
  /** Interest and penalty. */
  readonly lateFee: string;
  /** The owner's charges, such as the IPTU. */
  readonly charges: string;
  /** The office's fee, deducted. */
  readonly adminFee: string;
  /** Withheld by a company tenant. */
  readonly incomeTax: string;
}

export interface IncomeMonth {
  /** 1 to 12; 0 in the year's total. */
  readonly month: number;
  /** Rents paid by individual tenants: what the carnê-leão asks about. */
  readonly individual: IncomeFigures;
  /** Rents paid by companies, which withhold and report at source. */
  readonly company: IncomeFigures;
  readonly debits: string;
  readonly credits: string;
}

export interface IncomeReport {
  readonly person: PersonRef;
  readonly year: number;
  readonly months: readonly IncomeMonth[];
  readonly total: IncomeMonth;
}

export const MONTH_NAMES = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
] as const;

export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

/** Whether a month has anything to show. */
export function isEmptyMonth(m: IncomeMonth): boolean {
  const figures = [m.individual, m.company].flatMap((f) => [f.rent, f.lateFee, f.charges, f.adminFee, f.incomeTax]);
  return [...figures, m.debits, m.credits].every((v) => v === "0.00");
}

/** A year typed or taken from the address, when it is one the API accepts. */
export function reportYear(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{4}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 2000 && n <= 9999 ? n : undefined;
}

/** "1500.00" as Excel in Brazil reads a number: "1500,00". */
function spreadsheetNumber(value: string): string {
  const cents = parseMoney(value);
  if (cents === null) return value;
  return `${Math.trunc(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
}

function cell(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export const INCOME_COLUMNS = [
  "Mês",
  "Aluguel (locatário pessoa física)",
  "Multa e juros (pessoa física)",
  "Cobranças do proprietário (pessoa física)",
  "Taxa de administração (pessoa física)",
  "Aluguel (locatário empresa)",
  "Multa e juros (empresa)",
  "Cobranças do proprietário (empresa)",
  "Taxa de administração (empresa)",
  "IRRF retido pela empresa",
  "Débitos lançados",
  "Créditos lançados",
] as const;

function row(label: string, m: IncomeMonth): string[] {
  const f = (x: IncomeFigures) => [x.rent, x.lateFee, x.charges, x.adminFee];
  return [label, ...[...f(m.individual), ...f(m.company), m.company.incomeTax, m.debits, m.credits].map(spreadsheetNumber)];
}

/**
 * The report as a spreadsheet for Excel in Brazil: ";" between cells, CRLF,
 * and a byte order mark so the accents survive.
 */
export function incomeReportCsv(report: IncomeReport): string {
  const lines = [
    [...INCOME_COLUMNS],
    ...report.months.map((m) => row(monthName(m.month), m)),
    row(`Total ${report.year}`, report.total),
  ];
  return "﻿" + lines.map((cells) => cells.map(cell).join(";")).join("\r\n") + "\r\n";
}
