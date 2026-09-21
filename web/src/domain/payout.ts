/**
 * The owners' ledger and the payouts the office records (PLANO-REPASSE.md).
 *
 * Mirrors `internal/domain/ledger.go`. The lines a received rent writes are the
 * API's to compute; this module reads them, sums them and checks what a
 * person types.
 */

import type { FieldError } from "./errors.ts";
import { formatDate, formatMoneyInput, parseMoney } from "./contract.ts";
import type { PersonKind } from "./person.ts";
import type { PropertyAddress } from "./property.ts";
import { chargeLabel, type ChargeKind } from "./rent.ts";

export type EntryKind = "rent" | "late_fee" | "charge" | "admin_fee" | "income_tax" | "debit" | "credit";
export type PayoutMethod = "" | "pix" | "transfer" | "cash" | "check" | "other";

export interface PersonRef {
  readonly id: string;
  readonly name: string;
  readonly kind: PersonKind;
}

export interface LedgerEntry {
  readonly id: string;
  readonly personId: string;
  readonly kind: EntryKind;
  /** Always positive. */
  readonly amount: string;
  /** The line's effect on the balance, "-38.10" for a deduction. */
  readonly signed: string;
  readonly occurredOn: string;
  readonly description: string;
  readonly propertyId: string | null;
  readonly address: PropertyAddress | null;
  readonly contractId: string | null;
  readonly registry: string;
  readonly rent: { readonly sequence: number; readonly dueOn: string } | null;
  readonly charge: { readonly kind: ChargeKind; readonly description: string } | null;
  readonly payoutId: string | null;
}

export interface Balance {
  readonly person: PersonRef;
  /** Signed: below zero while debits wait for the next rent. */
  readonly pending: string;
  readonly lines: number;
  readonly oldestOn: string;
}

export interface PersonLedger {
  readonly person: PersonRef;
  readonly balance: string;
  readonly pending: readonly LedgerEntry[];
  readonly today: string;
}

export interface Payout {
  readonly id: string;
  readonly number: string;
  readonly person: PersonRef;
  readonly paidOn: string;
  readonly total: string;
  readonly method: PayoutMethod;
  readonly note: string;
  readonly createdAt: string;
}

export interface PayoutDetail extends Payout {
  readonly entries: readonly LedgerEntry[];
}

export interface PayoutsPage {
  readonly payouts: readonly Payout[];
  readonly nextCursor: string | null;
}

/** A debit or credit as typed. */
export interface ManualEntryInput {
  readonly kind: "debit" | "credit";
  readonly amount: string;
  readonly description: string;
  readonly occurredOn: string;
  readonly propertyId: string;
}

/** A payout as the office records it. */
export interface PayoutInput {
  readonly personId: string;
  readonly paidOn: string;
  readonly entryIds: readonly string[];
  readonly method: PayoutMethod;
  readonly note: string;
}

export const PAYOUT_METHODS: readonly (readonly [PayoutMethod, string])[] = [
  ["", "Não informar"],
  ["pix", "PIX"],
  ["transfer", "Transferência (TED)"],
  ["cash", "Dinheiro"],
  ["check", "Cheque"],
  ["other", "Outra"],
];

export function methodLabel(method: PayoutMethod): string {
  return method === "" ? "" : (PAYOUT_METHODS.find(([m]) => m === method)?.[1] ?? method);
}

export const ENTRY_KINDS: Readonly<Record<EntryKind, string>> = {
  rent: "Aluguel",
  late_fee: "Multa e juros",
  charge: "Cobrança",
  admin_fee: "Taxa de administração",
  income_tax: "IRRF retido pelo locatário",
  debit: "Débito",
  credit: "Crédito",
};

/** What a line is, as a statement names it. */
export function entryLabel(e: LedgerEntry): string {
  const rent = e.rent === null ? "" : `, parcela ${e.rent.sequence} de ${formatDate(e.rent.dueOn)}`;
  switch (e.kind) {
    case "rent":
      return `Aluguel${rent}`;
    case "charge": {
      const name = e.charge === null ? "Cobrança" : chargeLabel(e.charge.kind);
      const detail = e.charge !== null && e.charge.description !== "" ? `: ${e.charge.description}` : "";
      return `${name}${detail}${rent}`;
    }
    case "debit":
    case "credit":
      return e.description;
    default:
      return `${ENTRY_KINDS[e.kind]}${rent}`;
  }
}

/** A signed amount as the API writes it, in centavos: "-38.10" is -3810. */
export function parseSigned(value: string): number | null {
  const negative = value.trim().startsWith("-");
  const cents = parseMoney(negative ? value.trim().slice(1) : value);
  return cents === null ? null : negative ? -cents : cents;
}

/** Signed centavos as a person reads them: "R$ 1.038,10", "− R$ 38,10". */
export function formatSigned(cents: number): string {
  return cents < 0 ? `− R$ ${formatMoneyInput(-cents)}` : `R$ ${formatMoneyInput(cents)}`;
}

/** The balance a set of lines adds up to, in centavos. */
export function signedTotal(entries: readonly LedgerEntry[]): number {
  return entries.reduce((sum, e) => sum + (parseSigned(e.signed) ?? 0), 0);
}

/** Totals by kind, positive, in centavos: what a receipt summarises. */
export function totalsByKind(entries: readonly LedgerEntry[]): Readonly<Record<EntryKind, number>> {
  const out: Record<EntryKind, number> = { rent: 0, late_fee: 0, charge: 0, admin_fee: 0, income_tax: 0, debit: 0, credit: 0 };
  for (const e of entries) out[e.kind] += parseMoney(e.amount) ?? 0;
  return out;
}

/** Lines grouped by property, the typed lines without one last. */
export function groupByProperty(
  entries: readonly LedgerEntry[],
): readonly { readonly propertyId: string | null; readonly address: PropertyAddress | null; readonly entries: readonly LedgerEntry[] }[] {
  const groups = new Map<string, { propertyId: string | null; address: PropertyAddress | null; entries: LedgerEntry[] }>();
  for (const e of entries) {
    const key = e.propertyId ?? "";
    const group = groups.get(key) ?? { propertyId: e.propertyId, address: e.address, entries: [] };
    group.entries.push(e);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.propertyId === null ? 1 : b.propertyId === null ? -1 : 0));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** "2026-09-21" as a receipt writes it: "21 de setembro de 2026". */
export function formatLongDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const month = match === null ? undefined : MONTH_NAMES[Number(match[2]) - 1];
  return match === null || month === undefined ? value : `${Number(match[3])} de ${month} de ${match[1]}`;
}

export function validateManualEntry(e: ManualEntryInput, today: string): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  const amount = parseMoney(e.amount);
  if (e.amount.trim() === "") add("amount", "Informe o valor.");
  else if (amount === null) add("amount", "Use um valor como 250,00.");
  else if (amount === 0) add("amount", "O valor precisa ser maior que zero.");
  if (e.description.trim() === "") add("description", "Diga do que é este lançamento.");
  else if (e.description.trim().length > 120) add("description", "Use no máximo 120 caracteres.");
  if (!DATE.test(e.occurredOn)) add("occurredOn", "Informe a data.");
  else if (e.occurredOn > today) add("occurredOn", "A data não pode ser futura.");
  return problems;
}

/** `chosen` are the lines ticked, whose total must be above zero. */
export function validatePayout(p: PayoutInput, chosen: readonly LedgerEntry[], today: string): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  if (!DATE.test(p.paidOn)) add("paidOn", "Informe a data da transferência.");
  else if (p.paidOn > today) add("paidOn", "A transferência não pode ter data futura.");
  else if (chosen.some((e) => e.occurredOn > p.paidOn)) {
    add("paidOn", "Há lançamentos depois desta data. Use uma data igual ou posterior a eles.");
  }
  if (p.note.trim().length > 280) add("note", "Use no máximo 280 caracteres.");
  if (chosen.length === 0) add("entryIds", "Marque ao menos um lançamento.");
  else if (signedTotal(chosen) <= 0) add("entryIds", "O total marcado precisa ser maior que zero.");
  return problems;
}

/** The API's refusals about the ledger and payouts, in Portuguese. */
export function translatePayoutProblem(problem: FieldError): FieldError {
  const fields: Record<string, string> = {
    paid_on: "paidOn",
    entry_ids: "entryIds",
    occurred_on: "occurredOn",
    property_id: "propertyId",
    entry: "form",
  };
  const known: Record<string, string> = {
    "must not be in the future": "A data não pode ser futura.",
    "must add up to more than zero": "O total marcado precisa ser maior que zero.",
    "must all be pending": "Algum lançamento já entrou em outro repasse. Recarregue a página.",
    "must not be later than the payout": "Há lançamentos depois desta data. Use uma data igual ou posterior a eles.",
    "names a line that does not exist": "Algum lançamento não existe mais. Recarregue a página.",
    "must all be lines of the payout's beneficiary": "Há lançamentos de outra pessoa na seleção.",
    "must name at least one line": "Marque ao menos um lançamento.",
    "comes from a rent; reverse the rent's payment instead":
      "Este lançamento vem de um aluguel. Para removê-lo, estorne o pagamento do aluguel.",
    "is in a payout; undo the payout first": "Este lançamento já está num repasse. Desfaça o repasse antes.",
    "is required": "Preencha este campo.",
    "the carnê-leão report is for individuals": "O relatório para carnê-leão é só de pessoa física.",
    "must be a year such as 2026": "Informe um ano como 2026.",
  };
  return { field: fields[problem.field] ?? problem.field, message: known[problem.message] ?? "Valor não aceito. Confira este campo." };
}
