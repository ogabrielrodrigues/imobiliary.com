/**
 * The office's leases, as this platform shows and edits them.
 *
 * Mirrors `internal/domain/contract.go`. The API is the authority on every
 * rule; the checks here only answer sooner, in Portuguese, before a request
 * is spent. Money is handled in centavos and percentages in millionths, as the
 * API holds them, so nothing is ever rounded through a float.
 */

import type { FieldError } from "./errors.ts";
import type { PersonKind } from "./person.ts";
import { parseShare, shareForApi, shareFromApi, type PropertyAddress } from "./property.ts";

export type GuaranteeKind = "none" | "deposit" | "surety" | "surety_insurance" | "fund_assignment";
export type PartyRole = "landlord" | "tenant" | "guarantor" | "guarantor_spouse";
export type AdjustmentIndex = "igpm" | "ipca" | "inpc" | "ivar" | "igpdi";
export type NoticeCode = "advance_rent" | "guarantor_spouse_consent" | "deposit_limit" | "adjustment_period";
export type ContractStatus = "upcoming" | "active" | "expired" | "terminated";
export type RentStatus = "paid" | "overdue" | "pending";

export const MAX_PARTIES = 20;
export const MAX_CONTRACT_MONTHS = 600;

export const GUARANTEES: readonly (readonly [GuaranteeKind, string])[] = [
  ["none", "Sem garantia"],
  ["deposit", "Caução"],
  ["surety", "Fiança"],
  ["surety_insurance", "Seguro fiança"],
  ["fund_assignment", "Cessão fiduciária de quotas de fundo"],
];

export const INDEXES: readonly (readonly [AdjustmentIndex, string])[] = [
  ["igpm", "IGP-M"],
  ["ipca", "IPCA"],
  ["inpc", "INPC"],
  ["ivar", "IVAR"],
  ["igpdi", "IGP-DI"],
];

export const ROLE_LABELS: Readonly<Record<PartyRole, string>> = {
  landlord: "Locador",
  tenant: "Locatário",
  guarantor: "Fiador",
  guarantor_spouse: "Cônjuge do fiador",
};

export const STATUS_LABELS: Readonly<Record<ContractStatus, string>> = {
  upcoming: "A iniciar",
  active: "Vigente",
  expired: "Vencido",
  terminated: "Rescindido",
};

export const RENT_STATUS_LABELS: Readonly<Record<RentStatus, string>> = {
  paid: "Pago",
  overdue: "Em atraso",
  pending: "A vencer",
};

export function guaranteeLabel(kind: GuaranteeKind): string {
  return GUARANTEES.find(([k]) => k === kind)?.[1] ?? kind;
}

export function indexLabel(index: AdjustmentIndex): string {
  return INDEXES.find(([k]) => k === index)?.[1] ?? index;
}

/**
 * What each notice tells the office before it is acknowledged. The wording
 * states the risk and the law; it does not advise either way.
 */
export const NOTICES: Readonly<Record<NoticeCode, { readonly title: string; readonly text: string }>> = {
  advance_rent: {
    title: "Aluguel antecipado com garantia",
    text:
      "O contrato prevê aluguel antecipado e tem garantia. A Lei 8.245/91 (art. 20) " +
      "só permite cobrar o aluguel antecipado quando não há garantia, e a cobrança indevida é contravenção " +
      "penal (art. 43, III).",
  },
  guarantor_spouse_consent: {
    title: "Fiador casado sem o cônjuge",
    text:
      "Um fiador é casado, fora do regime de separação absoluta de bens, e o cônjuge não está entre as partes. " +
      "Sem a autorização do cônjuge a fiança pode ser anulada (Código Civil, art. 1.647, III; Súmula 332 do STJ).",
  },
  deposit_limit: {
    title: "Caução acima de três aluguéis",
    text: "A caução em dinheiro não pode passar de três meses de aluguel (Lei 8.245/91, art. 38, § 2º).",
  },
  adjustment_period: {
    title: "Reajuste antes de doze meses",
    text:
      "Faltam menos de doze meses desde o início do contrato ou o último reajuste. A Lei 10.192/2001 " +
      "(art. 2º, § 1º) torna nula a correção por índice em período menor que um ano, então este reajuste só vale " +
      "como acordo entre as partes.",
  },
};

export function isNoticeCode(value: string): value is NoticeCode {
  return value in NOTICES;
}

// --- values -------------------------------------------------------------------

/**
 * An amount as typed, in centavos, or null. Accepts "1500", "1500,50",
 * "1.500,50" and "1500.50"; a dot followed by exactly three digits is a
 * thousands separator, as in "1.500".
 */
export function parseMoney(value: string): number | null {
  let text = value.trim().replace(/^R\$\s*/, "");
  if (text === "") return null;
  if (text.includes(",")) {
    if (!/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(text)) return null;
    text = text.replaceAll(".", "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    text = text.replaceAll(".", "");
  } else if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (whole.length > 13) return null;
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Centavos as the API reads money: "1500.00". */
export function moneyForApi(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Centavos as a field shows them: "1.500,00". */
export function formatMoneyInput(cents: number): string {
  const whole = Math.floor(cents / 100).toLocaleString("pt-BR");
  return `${whole},${String(cents % 100).padStart(2, "0")}`;
}

/** The API's "1500.00" as a person reads it: "R$ 1.500,00". */
export function formatMoney(value: string): string {
  const cents = parseMoney(value);
  return cents === null ? value : `R$ ${formatMoneyInput(cents)}`;
}

/** The API's "1500.00" as a field shows it: "1.500,00". */
export function moneyFromApi(value: string): string {
  const cents = parseMoney(value);
  return cents === null ? value : formatMoneyInput(cents);
}

/** A percentage between 0 and 100, in millionths, or null. */
export function parsePercent(value: string): number | null {
  const millionths = parseShare(value);
  return millionths === null || millionths > 1_000_000 ? null : millionths;
}

export { shareForApi as percentForApi, shareFromApi as percentFromApi };

/** "2026-10-01" as "01/10/2026". */
export function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match === null ? value : `${match[3]}/${match[2]}/${match[1]}`;
}

// --- shapes -------------------------------------------------------------------

/**
 * What the form edits. Parties are kept as lists of ids per role, which is how
 * they are chosen on screen; the client turns them into `{ person_id, role }`.
 */
export interface ContractInput {
  readonly propertyId: string;
  readonly registry: string;
  readonly guaranteeKind: GuaranteeKind;
  /** Whether each month is paid at its start; null until the office chooses. */
  readonly advanceRent: boolean | null;
  readonly depositAmount: string;
  readonly rent: string;
  readonly adminFee: string;
  readonly latePenaltyRate: string;
  readonly lateInterestRate: string;
  /** Empty for the day of the signature. */
  readonly dueDay: string;
  readonly adjustmentIndex: AdjustmentIndex;
  readonly signedOn: string;
  readonly startsOn: string;
  readonly expiresOn: string;
  readonly landlordIds: readonly string[];
  readonly tenantIds: readonly string[];
  readonly guarantorIds: readonly string[];
  readonly guarantorSpouseIds: readonly string[];
  readonly acknowledgments: readonly NoticeCode[];
}

export interface ContractParty {
  readonly personId: string;
  readonly role: PartyRole;
  readonly name: string;
  readonly kind: PersonKind;
}

export interface Rent {
  readonly id: string;
  readonly sequence: number;
  readonly dueOn: string;
  readonly amount: string;
  readonly lateFee: string;
  readonly amountPaid: string | null;
  readonly paidOn: string | null;
  readonly status: RentStatus;
}

export interface ContractTerms {
  readonly propertyId: string;
  readonly registry: string;
  readonly guaranteeKind: GuaranteeKind;
  readonly advanceRent: boolean;
  readonly depositAmount: string;
  readonly rent: string;
  readonly currentRent: string;
  readonly adminFee: string;
  readonly latePenaltyRate: string;
  readonly lateInterestRate: string;
  readonly dueDay: number;
  readonly adjustmentIndex: AdjustmentIndex;
  readonly signedOn: string;
  readonly startsOn: string;
  readonly expiresOn: string;
  readonly terminatedOn: string | null;
  readonly status: ContractStatus;
}

export interface Amendment {
  readonly id: string;
  readonly amendedOn: string;
  readonly adjustmentIndex: AdjustmentIndex | "";
  /** As the API writes it: "4.50", "-2.00". */
  readonly indexRate: string;
  readonly previousRent: string;
  readonly indexedRent: string;
  readonly periodAcknowledgedAt: string | null;
}

export interface Contract extends ContractTerms {
  readonly id: string;
  readonly address: PropertyAddress;
  readonly parties: readonly ContractParty[];
  readonly acknowledgments: readonly { readonly code: NoticeCode; readonly acknowledgedAt: string }[];
  readonly rents: readonly Rent[];
  /** Rent adjustments, oldest first. */
  readonly amendments: readonly Amendment[];
  readonly version: number;
}

export interface ContractSummary extends ContractTerms {
  readonly id: string;
  readonly address: PropertyAddress;
  readonly tenantNames: readonly string[];
}

export interface ContractsPage {
  readonly contracts: readonly ContractSummary[];
  readonly nextCursor: string | null;
}

export interface Instalment {
  readonly sequence: number;
  readonly dueOn: string;
  readonly amount: string;
}

export interface ContractPreview {
  readonly schedule: readonly Instalment[];
  readonly notices: readonly NoticeCode[];
  readonly total: string;
}

export function emptyContract(): ContractInput {
  return {
    propertyId: "",
    registry: "",
    guaranteeKind: "none",
    advanceRent: null,
    depositAmount: "",
    rent: "",
    adminFee: "10",
    latePenaltyRate: "10",
    lateInterestRate: "1",
    dueDay: "",
    adjustmentIndex: "igpm",
    signedOn: "",
    startsOn: "",
    expiresOn: "",
    landlordIds: [],
    tenantIds: [],
    guarantorIds: [],
    guarantorSpouseIds: [],
    acknowledgments: [],
  };
}

/** A saved contract back in the form's shape, for editing. */
export function contractToInput(c: Contract): ContractInput {
  const ids = (role: PartyRole) => c.parties.filter((p) => p.role === role).map((p) => p.personId);
  return {
    propertyId: c.propertyId,
    registry: c.registry,
    guaranteeKind: c.guaranteeKind,
    advanceRent: c.advanceRent,
    depositAmount: c.guaranteeKind === "deposit" ? moneyFromApi(c.depositAmount) : "",
    rent: moneyFromApi(c.rent),
    adminFee: shareFromApi(c.adminFee),
    latePenaltyRate: shareFromApi(c.latePenaltyRate),
    lateInterestRate: shareFromApi(c.lateInterestRate),
    dueDay: String(c.dueDay),
    adjustmentIndex: c.adjustmentIndex,
    signedOn: c.signedOn,
    startsOn: c.startsOn,
    expiresOn: c.expiresOn,
    landlordIds: ids("landlord"),
    tenantIds: ids("tenant"),
    guarantorIds: ids("guarantor"),
    guarantorSpouseIds: ids("guarantor_spouse"),
    acknowledgments: c.acknowledgments.map((a) => a.code),
  };
}

/** The parties in the order the API keeps them: landlords, tenants, guarantors. */
export function partiesOf(c: ContractInput): { personId: string; role: PartyRole }[] {
  return [
    ...c.landlordIds.map((personId) => ({ personId, role: "landlord" as const })),
    ...c.tenantIds.map((personId) => ({ personId, role: "tenant" as const })),
    ...c.guarantorIds.map((personId) => ({ personId, role: "guarantor" as const })),
    ...c.guarantorSpouseIds.map((personId) => ({ personId, role: "guarantor_spouse" as const })),
  ];
}

// --- rules --------------------------------------------------------------------

/** The step of the form a field belongs to, so an error can send the person back to it. */
export type ContractStep = "property" | "parties" | "terms" | "review";

export function stepOfField(field: string): ContractStep {
  if (field === "propertyId" || field === "registry" || field === "property_id") return "property";
  if (field.startsWith("parties") || /Ids$/.test(field) || field === "guaranteeKind" || field === "advanceRent") {
    return "parties";
  }
  if (field === "acknowledgments" || field === "rents" || field === "terminated_on") return "review";
  return "terms";
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A date n months later, a day the month lacks falling on its last day. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + n;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** Whole months plus one for a remainder, as the API counts instalments. */
export function termMonths(startsOn: string, expiresOn: string): number {
  const [sy, sm] = startsOn.split("-").map(Number) as [number, number];
  const [ey, em] = expiresOn.split("-").map(Number) as [number, number];
  let months = (ey - sy) * 12 + (em - sm);
  while (months > 0 && addMonths(startsOn, months) > expiresOn) months--;
  if (addMonths(startsOn, months) < expiresOn) months++;
  return Math.max(months, 1);
}

export function validateContract(c: ContractInput): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });

  if (c.propertyId === "") add("propertyId", "Escolha o imóvel.");
  if (c.registry.trim() === "") add("registry", "Informe o número do contrato.");
  else if (c.registry.trim().length > 60) add("registry", "Use no máximo 60 caracteres.");

  if (c.landlordIds.length === 0) add("landlordIds", "Informe ao menos um locador.");
  if (c.tenantIds.length === 0) add("tenantIds", "Informe ao menos um locatário.");
  const guarantors = [...c.guarantorIds, ...c.guarantorSpouseIds];
  if (c.guaranteeKind === "surety" && c.guarantorIds.length === 0) {
    add("guarantorIds", "A fiança precisa de ao menos um fiador.");
  }
  if (c.tenantIds.some((id) => guarantors.includes(id))) {
    add("guarantorIds", "Um locatário não pode ser fiador do próprio contrato.");
  }
  if (c.tenantIds.some((id) => c.landlordIds.includes(id))) {
    add("tenantIds", "A mesma pessoa não pode ser locadora e locatária.");
  }
  if (partiesOf(c).length > MAX_PARTIES) add("tenantIds", `Informe no máximo ${MAX_PARTIES} partes no total.`);

  if (c.advanceRent === null) add("advanceRent", "Informe se o aluguel é antecipado.");

  const rent = parseMoney(c.rent);
  if (c.rent.trim() === "") add("rent", "Informe o valor do aluguel.");
  else if (rent === null) add("rent", "Use um valor como 1.500,00.");
  else if (rent === 0) add("rent", "O aluguel precisa ser maior que zero.");

  if (c.guaranteeKind === "deposit") {
    const deposit = parseMoney(c.depositAmount);
    if (c.depositAmount.trim() === "") add("depositAmount", "Informe o valor da caução.");
    else if (deposit === null) add("depositAmount", "Use um valor como 4.500,00.");
    else if (deposit === 0) add("depositAmount", "A caução precisa ser maior que zero.");
  }

  for (const [field, value] of [
    ["adminFee", c.adminFee],
    ["latePenaltyRate", c.latePenaltyRate],
    ["lateInterestRate", c.lateInterestRate],
  ] as const) {
    if (parsePercent(value) === null) add(field, "Use um percentual entre 0 e 100, como 10 ou 0,5.");
  }

  if (c.dueDay.trim() !== "") {
    const day = Number(c.dueDay);
    if (!Number.isInteger(day) || day < 1 || day > 31) add("dueDay", "Use um dia entre 1 e 31.");
  }

  if (!DATE.test(c.signedOn)) add("signedOn", "Informe a data da assinatura.");
  if (!DATE.test(c.startsOn)) add("startsOn", "Informe o início.");
  if (!DATE.test(c.expiresOn)) add("expiresOn", "Informe o fim.");
  else if (DATE.test(c.startsOn)) {
    if (c.expiresOn <= c.startsOn) add("expiresOn", "O fim precisa ser depois do início.");
    else if (termMonths(c.startsOn, c.expiresOn) > MAX_CONTRACT_MONTHS) add("expiresOn", "O prazo passa de 50 anos.");
  }
  return problems;
}

/** The API's snake_case field as the form names it. */
export function contractFormField(apiField: string): string {
  const map: Record<string, string> = {
    property_id: "propertyId",
    guarantee_kind: "guaranteeKind",
    advance_rent: "advanceRent",
    deposit_amount: "depositAmount",
    admin_fee: "adminFee",
    late_penalty_rate: "latePenaltyRate",
    late_interest_rate: "lateInterestRate",
    due_day: "dueDay",
    adjustment_index: "adjustmentIndex",
    signed_on: "signedOn",
    starts_on: "startsOn",
    expires_on: "expiresOn",
  };
  if (apiField.startsWith("parties")) return "parties";
  return map[apiField] ?? apiField;
}

/** The API's messages for what only it checks, in Portuguese and on the form's fields. */
export function translateContractProblem(problem: FieldError): FieldError {
  const field = contractFormField(problem.field);
  if (problem.field === "acknowledgments" && isNoticeCode(problem.message)) {
    return { field, message: `Confirme a ciência do aviso "${NOTICES[problem.message].title}".` };
  }
  const known: Record<string, string> = {
    "the property already has a contract in this period": "O imóvel já tem um contrato neste período.",
    "is already used by another contract": "Este número já está em outro contrato.",
    "names a property that does not exist": "Este imóvel não existe mais no escritório.",
    "names a person or property that does not exist": "Uma das partes não existe mais no escritório.",
    "names a person that does not exist": "Uma das partes não existe mais no escritório.",
    "appears twice in the same role": "A mesma pessoa aparece duas vezes no mesmo papel.",
    "a terminated contract cannot be edited": "Um contrato rescindido não pode ser alterado.",
    "an instalment was already paid, so the schedule cannot be generated again":
      "Já há aluguel pago neste contrato, então os valores e as datas não podem mudar.",
    "a guarantor must be an individual": "Fiadores e cônjuges precisam ser pessoas físicas.",
    "a tenant cannot guarantee their own lease": "Um locatário não pode ser fiador do próprio contrato.",
    "a person cannot be landlord and tenant of the same lease": "A mesma pessoa não pode ser locadora e locatária.",
    "must name a guarantor with a surety guarantee": "A fiança precisa de ao menos um fiador.",
    "may have guarantors only with a surety guarantee": "Fiadores só entram quando a garantia é fiança.",
  };
  return { field, message: known[problem.message] ?? "Valor não aceito. Confira este campo." };
}

// --- adjustments ----------------------------------------------------------------

/** What the office types to adjust a rent. An empty rent takes the suggestion. */
export interface AmendmentInput {
  readonly amendedOn: string;
  /** As typed, signed: "4,5", "-2". */
  readonly indexRate: string;
  readonly indexedRent: string;
  readonly acknowledgments: readonly NoticeCode[];
}

export interface AmendmentPreview {
  readonly previousRent: string;
  readonly suggestedRent: string;
  readonly indexedRent: string;
  readonly firstSequence: number;
  readonly affectedRents: number;
  readonly firstDueOn: string | null;
  readonly notices: readonly NoticeCode[];
}

/** A signed percentage above -100 and at most 100, in millionths, or null. */
export function parseSignedPercent(value: string): number | null {
  const text = value.trim();
  const negative = text.startsWith("-");
  const millionths = parsePercent(negative ? text.slice(1) : text);
  if (millionths === null) return null;
  if (negative && millionths >= 1_000_000) return null;
  return negative ? -millionths : millionths;
}

/** Millionths as the API reads a signed rate: "-3.1812". */
export function signedPercentForApi(millionths: number): string {
  return millionths < 0 ? `-${shareForApi(-millionths)}` : shareForApi(millionths);
}

/** The API's "-3.18" as a person reads it: "-3,18". */
export function formatSignedPercent(value: string): string {
  return value.startsWith("-") ? `-${shareFromApi(value.slice(1))}` : shareFromApi(value);
}

export function validateAmendment(a: AmendmentInput, c: Pick<ContractTerms, "startsOn" | "expiresOn">): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });
  if (!DATE.test(a.amendedOn)) add("amendedOn", "Informe a partir de quando vale o reajuste.");
  else if (a.amendedOn <= c.startsOn) add("amendedOn", "O reajuste vale depois do início do contrato.");
  else if (a.amendedOn > c.expiresOn) add("amendedOn", "O reajuste precisa valer antes do fim do contrato.");
  if (a.indexRate.trim() === "") add("indexRate", "Informe a variação do índice no período.");
  else if (parseSignedPercent(a.indexRate) === null) add("indexRate", "Use um percentual como 4,5 ou -1,2.");
  if (a.indexedRent.trim() !== "") {
    const rent = parseMoney(a.indexedRent);
    if (rent === null) add("indexedRent", "Use um valor como 1.567,50.");
    else if (rent === 0) add("indexedRent", "O aluguel precisa ser maior que zero.");
  }
  return problems;
}

/** The API's messages about an adjustment, in Portuguese and on the dialog's fields. */
export function translateAmendmentProblem(problem: FieldError): FieldError {
  const fields: Record<string, string> = {
    amended_on: "amendedOn",
    index_rate: "indexRate",
    indexed_rent: "indexedRent",
  };
  const field = fields[problem.field] ?? problem.field;
  if (problem.field === "acknowledgments" && isNoticeCode(problem.message)) {
    return { field, message: `Confirme a ciência do aviso "${NOTICES[problem.message].title}".` };
  }
  const known: Record<string, string> = {
    "must be after the start": "O reajuste vale depois do início do contrato.",
    "must not be after the expiry": "O reajuste precisa valer antes do fim do contrato.",
    "must be after the last adjustment": "O reajuste precisa valer depois do último registrado.",
    "a terminated contract cannot be adjusted": "Um contrato rescindido não recebe reajuste.",
    "a rent from this day on is already paid": "Já há aluguel pago a partir desta data.",
    "must be above -100 and at most 100": "Use um percentual entre -100 e 100.",
    "makes a rent out of range": "O aluguel reajustado ficaria alto demais.",
    "only the last adjustment can be undone": "Só o último reajuste pode ser desfeito.",
    "a terminated contract keeps its adjustments": "Um contrato rescindido mantém seus reajustes.",
    "a rent it reached is already paid": "Já há aluguel pago com o valor deste reajuste.",
  };
  return { field, message: known[problem.message] ?? "Valor não aceito. Confira este campo." };
}

export function validateTermination(c: Pick<ContractTerms, "startsOn" | "expiresOn">, on: string): string | null {
  if (!DATE.test(on)) return "Informe a data da rescisão.";
  if (on < c.startsOn) return "A rescisão não pode ser antes do início.";
  if (on > c.expiresOn) return "A rescisão não pode ser depois do fim.";
  return null;
}

export function translateTerminationProblem(message: string): string {
  const known: Record<string, string> = {
    "the contract is already terminated": "Este contrato já foi rescindido.",
    "must not be before the start": "A rescisão não pode ser antes do início.",
    "must not be after the expiry": "A rescisão não pode ser depois do fim.",
    "a rent for a month after this day is already paid": "Já há aluguel pago de um mês depois desta data.",
  };
  return known[message] ?? "Data não aceita.";
}

