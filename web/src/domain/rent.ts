/**
 * Instalments across contracts, payments, charges and the dashboard.
 *
 * Mirrors `internal/domain/rent.go` and `rent_payment.go`. The interest and
 * penalty are the API's to compute: this module only reads what it answers,
 * shows how a partial payment splits, and checks what a person types.
 */

import type { FieldError } from "./errors.ts";
import { formatDate, formatMoney, parseMoney } from "./contract.ts";
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

/** Where a charge's money goes once paid. */
export type ChargeDestination = "owner" | "third_party";

export const CHARGE_DESTINATIONS: readonly (readonly [ChargeDestination, string, string])[] = [
  ["third_party", "Terceiro", "O escritório paga (condomínio, concessionária). Não entra no repasse nem na taxa."],
  ["owner", "Proprietário", "Entra no repasse e na base da taxa de administração."],
];

export function destinationLabel(d: ChargeDestination): string {
  return CHARGE_DESTINATIONS.find(([k]) => k === d)?.[1] ?? d;
}

/** Mirrors SuggestedDestination in Go: the IPTU is the owner's, the rest a third party's. */
export function suggestedDestination(kind: ChargeKind): ChargeDestination {
  return kind === "property_tax" ? "owner" : "third_party";
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
  /** The interest and penalty the payments settled. */
  readonly lateFee: string;
  /** The sum of the payments; null before any. */
  readonly amountPaid: string | null;
  /** The day the rent was settled; null while anything is open. */
  readonly paidOn: string | null;
  /** What a company tenant withheld as income tax; "0.00" otherwise. */
  readonly incomeTaxWithheld: string;
  /** The part of the rent and charges settled, and the part still open. */
  readonly principalPaid: string;
  readonly outstanding: string;
  /** Money came in and something is still open; the status stays pending or overdue. */
  readonly partiallyPaid: boolean;
  readonly status: RentStatus;
}

export interface RentPayment {
  readonly id: string;
  readonly paidOn: string;
  /** What came in. */
  readonly amount: string;
  /** Interest and penalty settled, and forgiven. */
  readonly lateFee: string;
  readonly waived: string;
  /** Rent and charges settled. */
  readonly principal: string;
  readonly incomeTaxWithheld: string;
}

export interface Charge {
  readonly id: string;
  readonly kind: ChargeKind;
  readonly description: string;
  readonly amount: string;
  readonly destination: ChargeDestination;
}

export interface LateFee {
  readonly daysLate: number;
  readonly penalty: string;
  readonly interest: string;
  readonly total: string;
}

export interface RentDetail extends RentSummary {
  readonly charges: readonly Charge[];
  /** In the order they settle, by day. */
  readonly payments: readonly RentPayment[];
  /** The interest and penalty owed today; zero once paid. */
  readonly suggestedLateFee: LateFee;
  /** Everything owed today; "0.00" once paid. */
  readonly owedToday: string;
}

export interface RentsPage {
  readonly rents: readonly RentSummary[];
  readonly nextCursor: string | null;
}

/** What a rent owes on a day. */
export interface PaymentPreview {
  readonly lateFee: LateFee;
  /** The rent and charges still open. */
  readonly principal: string;
  readonly total: string;
}

/**
 * A payment as typed. An empty amount settles everything owed on the day,
 * computed by the API; an amount is a partial payment. An empty late fee
 * charges the interest and penalty owed.
 */
export interface PaymentInput {
  readonly paidOn: string;
  readonly amount: string;
  readonly lateFee: string;
  readonly incomeTax: string;
}

export interface ChargeInput {
  readonly kind: ChargeKind;
  readonly description: string;
  readonly amount: string;
  readonly destination: ChargeDestination;
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
    readonly paidOut: string;
    readonly paidOutCount: number;
  };
  /** What the office owes its owners today, and to how many. */
  readonly payouts: { readonly pending: string; readonly beneficiaries: number };
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

/**
 * `taxRoom` is what the tenant can still withhold, the rent less what earlier
 * payments withheld; left out, only the API checks that limit.
 */
export function validatePayment(p: PaymentInput, today: string, taxRoom?: string): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  if (!DATE.test(p.paidOn)) add("paidOn", "Informe a data do pagamento.");
  else if (p.paidOn > today) add("paidOn", "O pagamento não pode ter data futura.");
  if (p.amount.trim() !== "") {
    const amount = parseMoney(p.amount);
    if (amount === null) add("amount", "Use um valor como 800,00.");
    else if (amount === 0) add("amount", "O valor precisa ser maior que zero.");
  }
  if (p.lateFee.trim() !== "" && parseMoney(p.lateFee) === null) add("lateFee", "Use um valor como 160,00 ou 0.");
  if (p.incomeTax.trim() !== "") {
    const tax = parseMoney(p.incomeTax);
    const limit = taxRoom === undefined ? null : parseMoney(taxRoom);
    if (tax === null) add("incomeTax", "Use um valor como 112,50 ou 0.");
    else if (limit !== null && tax > limit) add("incomeTax", "O IRRF retido não pode passar do aluguel.");
  }
  return problems;
}

/**
 * What a payment of everything brings in, in centavos: the rent and charges
 * still open and the late fee, less the tax withheld; null while a field
 * cannot be read.
 */
export function amountReceived(open: string, lateFee: string, incomeTax: string): number | null {
  const d = parseMoney(open);
  const fee = lateFee.trim() === "" ? 0 : parseMoney(lateFee);
  const tax = incomeTax.trim() === "" ? 0 : parseMoney(incomeTax);
  if (d === null || fee === null || tax === null || tax > d + fee) return null;
  return d + fee - tax;
}

/** How a partial payment settles, in centavos. */
export interface PartialSplit {
  /** Interest and penalty settled first. */
  readonly lateFee: number;
  /** Then the rent and charges. */
  readonly principal: number;
  /** The rent and charges left open. */
  readonly remaining: number;
  /** More than is owed. */
  readonly exceeds: boolean;
}

/**
 * Mirrors PlanPayment in Go: what came in, with the tax withheld, pays the
 * interest and penalty charged first, then the principal. Null while a field
 * cannot be read.
 */
export function splitPartial(amount: string, incomeTax: string, lateFee: string, open: string): PartialSplit | null {
  const a = parseMoney(amount);
  const tax = incomeTax.trim() === "" ? 0 : parseMoney(incomeTax);
  const fee = parseMoney(lateFee);
  const o = parseMoney(open);
  if (a === null || tax === null || fee === null || o === null) return null;
  const settles = a + tax;
  const paidFee = Math.min(settles, fee);
  const principal = settles - paidFee;
  return { lateFee: paidFee, principal: Math.min(principal, o), remaining: Math.max(o - principal, 0), exceeds: principal > o };
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
  const fields: Record<string, string> = {
    paid_on: "paidOn",
    amount: "amount",
    late_fee: "lateFee",
    income_tax_withheld: "incomeTax",
    payment: "form",
    destination: "destination",
  };
  const atMost = /^must be at most (\d+\.\d{2}), what is owed$/.exec(problem.message);
  if (atMost?.[1] !== undefined) {
    return { field: "amount", message: `O valor passa do que falta, ${formatMoney(atMost[1])}.` };
  }
  const feeAtMost = /^must be at most (\d+\.\d{2}), the interest and penalty owed$/.exec(problem.message);
  if (feeAtMost?.[1] !== undefined) {
    return { field: "lateFee", message: `Multa e juros devidos são ${formatMoney(feeAtMost[1])}; não dá para cobrar mais.` };
  }
  const beforeLast = /^must not be before the last payment, on (\d{4}-\d{2}-\d{2})$/.exec(problem.message);
  if (beforeLast?.[1] !== undefined) {
    return { field: "paidOn", message: `A data não pode ser anterior à do último pagamento, ${formatDate(beforeLast[1])}.` };
  }
  const inPayout = /^the rent is in payout (\d{4}\/\d{4}); undo the payout first$/.exec(problem.message);
  if (inPayout !== null) {
    return {
      field: fields[problem.field] ?? problem.field,
      message: `Este aluguel já entrou no repasse ${inPayout[1]}. Desfaça o repasse antes.`,
    };
  }
  const known: Record<string, string> = {
    "must be between zero and the rent": "O IRRF retido não pode passar do aluguel.",
    "must not exceed the rent": "O IRRF retido, somado ao dos pagamentos anteriores, não pode passar do aluguel.",
    "must not exceed what the payment settles": "O IRRF retido não pode passar do que o pagamento quita.",
    "must be greater than zero": "O valor precisa ser maior que zero.",
    "the rent is paid": "Este aluguel já está pago.",
    "must be owner or third_party": "Escolha para onde vai esta cobrança.",
    "the rent is in a payout; undo the payout first": "Este aluguel já entrou num repasse. Desfaça o repasse antes.",
    "the contract does not say how its landlords share the rent; record their shares first":
      "O contrato não diz a cota de cada locador. Informe as cotas no contrato antes de receber.",
    "must not be in the future": "O pagamento não pode ter data futura.",
    "the rent is not paid": "Este aluguel não está pago.",
    "a paid rent's charges cannot change": "Depois de um pagamento as cobranças não mudam. Estorne os pagamentos antes.",
    "must be at most 20": "Um aluguel tem no máximo 20 cobranças.",
    "is required for another charge": "Diga do que é esta cobrança.",
  };
  return { field: fields[problem.field] ?? problem.field, message: known[problem.message] ?? "Valor não aceito. Confira este campo." };
}
