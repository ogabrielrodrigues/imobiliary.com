/**
 * Instalments across contracts, payments, charges and the dashboard.
 *
 * Mirrors `internal/domain/rent.go`. The late fee is the API's to compute:
 * this module only reads what it answers and checks what a person types.
 */

import type { FieldError } from "./errors.ts";
import { parseMoney } from "./contract.ts";
import type { PropertyAddress } from "./property.ts";

export type RentStatus = "paid" | "overdue" | "pending";
export type ChargeKind = "condominium" | "property_tax" | "water" | "energy" | "other";

export const CHARGE_KINDS: readonly (readonly [ChargeKind, string])[] = [
  ["condominium", "Condomínio"],
  ["property_tax", "IPTU"],
  ["water", "Água"],
  ["energy", "Energia"],
  ["other", "Outra"],
];

export function chargeLabel(kind: ChargeKind): string {
  return CHARGE_KINDS.find(([k]) => k === kind)?.[1] ?? kind;
}

export interface RentContract {
  readonly id: string;
  readonly registry: string;
  readonly address: PropertyAddress;
  readonly tenantNames: readonly string[];
}

export interface RentSummary {
  readonly id: string;
  readonly contract: RentContract;
  readonly sequence: number;
  readonly dueOn: string;
  readonly amount: string;
  readonly chargesTotal: string;
  /** The rent with its charges. */
  readonly due: string;
  readonly lateFee: string;
  readonly amountPaid: string | null;
  readonly paidOn: string | null;
  readonly status: RentStatus;
}

export interface Charge {
  readonly id: string;
  readonly kind: ChargeKind;
  readonly description: string;
  readonly amount: string;
}

export interface LateFee {
  readonly daysLate: number;
  readonly penalty: string;
  readonly interest: string;
  readonly total: string;
}

export interface RentDetail extends RentSummary {
  readonly charges: readonly Charge[];
  /** For paying today; zero once paid. */
  readonly suggestedLateFee: LateFee;
}

export interface RentsPage {
  readonly rents: readonly RentSummary[];
  readonly nextCursor: string | null;
}

export interface PaymentPreview {
  readonly lateFee: LateFee;
  readonly total: string;
}

/** A payment as typed. Empty amounts take the API's computation. */
export interface PaymentInput {
  readonly paidOn: string;
  readonly lateFee: string;
  readonly amountPaid: string;
}

export interface ChargeInput {
  readonly kind: ChargeKind;
  readonly description: string;
  readonly amount: string;
}

export interface ContractDeadline {
  readonly contractId: string;
  readonly registry: string;
  readonly address: PropertyAddress;
  readonly on: string;
}

export interface Dashboard {
  readonly today: string;
  readonly monthStart: string;
  readonly monthEnd: string;
  readonly month: {
    readonly expected: string;
    readonly expectedCount: number;
    readonly received: string;
    readonly receivedCount: number;
    readonly open: string;
    readonly openCount: number;
    readonly officeFee: string;
  };
  readonly overdue: { readonly count: number; readonly amount: string };
  readonly portfolio: {
    readonly properties: number;
    readonly leasedProperties: number;
    readonly activeContracts: number;
    readonly rentRoll: string;
  };
  readonly expiring: readonly ContractDeadline[];
  readonly adjustments: readonly ContractDeadline[];
  readonly dueToday: readonly RentSummary[];
  readonly overdueRents: readonly RentSummary[];
}

export const RENT_STATUS: Readonly<Record<RentStatus, string>> = {
  paid: "Pago",
  overdue: "Em atraso",
  pending: "A vencer",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in America/Sao_Paulo as YYYY-MM-DD, the office's calendar. */
export function todayInSaoPaulo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
}

/** "2026-10" as its first and last day. */
export function monthRange(month: string): { from: string; to: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return null;
  const year = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${match[1]}-${match[2]}-01`, to: `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}` };
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "2026-10" as "outubro de 2026". */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match === null ? undefined : MONTHS[Number(match[2]) - 1];
  return match === null || name === undefined ? month : `${name} de ${match[1]}`;
}

/** Days from one date to another, negative when the second is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function validatePayment(p: PaymentInput, today: string): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  if (!DATE.test(p.paidOn)) add("paidOn", "Informe a data do pagamento.");
  else if (p.paidOn > today) add("paidOn", "O pagamento não pode ter data futura.");
  if (p.lateFee.trim() !== "" && parseMoney(p.lateFee) === null) add("lateFee", "Use um valor como 160,00 ou 0.");
  if (p.amountPaid.trim() !== "") {
    const amount = parseMoney(p.amountPaid);
    if (amount === null) add("amountPaid", "Use um valor como 1.760,00.");
    else if (amount === 0) add("amountPaid", "O valor recebido precisa ser maior que zero.");
  }
  return problems;
}

export function validateCharge(c: ChargeInput): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  if (c.kind === "other" && c.description.trim() === "") add("description", "Diga do que é esta cobrança.");
  if (c.description.trim().length > 120) add("description", "Use no máximo 120 caracteres.");
  const amount = parseMoney(c.amount);
  if (c.amount.trim() === "") add("amount", "Informe o valor.");
  else if (amount === null) add("amount", "Use um valor como 450,00.");
  else if (amount === 0) add("amount", "O valor precisa ser maior que zero.");
  return problems;
}

/** The API's messages about rents, in Portuguese and on the form's fields. */
export function translateRentProblem(problem: FieldError): FieldError {
  const fields: Record<string, string> = { paid_on: "paidOn", amount_paid: "amountPaid", late_fee: "lateFee" };
  const known: Record<string, string> = {
    "must not be in the future": "O pagamento não pode ter data futura.",
    "the rent is not paid": "Este aluguel não está pago.",
    "a paid rent's charges cannot change": "As cobranças de um aluguel pago não mudam. Estorne o pagamento antes.",
    "must be at most 20": "Um aluguel tem no máximo 20 cobranças.",
    "is required for another charge": "Diga do que é esta cobrança.",
  };
  return { field: fields[problem.field] ?? problem.field, message: known[problem.message] ?? "Valor não aceito. Confira este campo." };
}
