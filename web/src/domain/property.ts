/**
 * The office's properties, as this platform shows and edits them.
 *
 * Mirrors `internal/domain/property.go`. Shares are handled in millionths, as
 * the API holds them, so "33,3333" three times is never rounded into 100: the
 * form says it adds up to 99,9999 and offers to split evenly instead.
 */

import type { FieldError } from "./errors.ts";
import { addressLineProblems, type PersonKind } from "./person.ts";

export const FULL_SHARE = 1_000_000;
export const MAX_OWNERS = 20;

export interface PropertyAddress {
  readonly street: string;
  readonly number: string;
  readonly complement: string;
  readonly district: string;
  readonly city: string;
  readonly state: string;
  readonly zipCode: string;
  readonly observation: string;
}

export interface OwnerInput {
  readonly personId: string;
  /** As typed: "50", "33,3333". */
  readonly share: string;
}

export interface PropertyInput {
  readonly address: PropertyAddress;
  readonly registry: string;
  readonly registryOffice: string;
  readonly municipalRegistration: string;
  readonly waterCode: string;
  readonly energyCode: string;
  readonly owners: readonly OwnerInput[];
}

export interface PropertyOwner {
  readonly personId: string;
  readonly share: string;
  readonly name: string;
  readonly kind: PersonKind;
}

export interface Property extends Omit<PropertyInput, "owners"> {
  readonly id: string;
  readonly owners: readonly PropertyOwner[];
  readonly version: number;
}

export interface PropertySummary {
  readonly id: string;
  readonly address: PropertyAddress;
  readonly registry: string;
  readonly ownerNames: readonly string[];
}

export interface PropertiesPage {
  readonly properties: readonly PropertySummary[];
  readonly nextCursor: string | null;
}

export function emptyPropertyAddress(): PropertyAddress {
  return { street: "", number: "", complement: "", district: "", city: "", state: "", zipCode: "", observation: "" };
}

export function emptyProperty(): PropertyInput {
  return {
    address: emptyPropertyAddress(),
    registry: "",
    registryOffice: "",
    municipalRegistration: "",
    waterCode: "",
    energyCode: "",
    owners: [],
  };
}

/**
 * A share as typed, in millionths, or null when it is not a percentage with
 * up to four decimal places. A comma or a dot separates the decimals.
 */
export function parseShare(value: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,4}))?$/.exec(value.trim());
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(4, "0"));
  return whole * 10_000 + fraction;
}

/** Millionths as the API reads a rate: "33.3333", "50". */
export function shareForApi(millionths: number): string {
  const whole = Math.floor(millionths / 10_000);
  const fraction = String(millionths % 10_000).padStart(4, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

/** Millionths as a person reads them: "33,3333", "50". */
export function formatShare(millionths: number): string {
  return shareForApi(millionths).replace(".", ",");
}

/** The API's "50.00" as the form shows it: "50". */
export function shareFromApi(value: string): string {
  const millionths = parseShare(value);
  return millionths === null ? value : formatShare(millionths);
}

/**
 * Equal shares for n owners, the last taking the remainder so they add up to
 * exactly 100: three owners get 33,3333, 33,3333 and 33,3334.
 */
export function splitEvenly(n: number): string[] {
  if (n <= 0) return [];
  const each = Math.floor(FULL_SHARE / n);
  return Array.from({ length: n }, (_, i) => formatShare(i === n - 1 ? FULL_SHARE - each * (n - 1) : each));
}

/**
 * The owners as they are sent: a single owner holds 100% whatever the hidden
 * field says, so a share typed while there were two owners cannot linger.
 */
export function ownersToSave(owners: readonly OwnerInput[]): OwnerInput[] {
  return owners.length === 1 ? owners.map((owner) => ({ ...owner, share: "100" })) : [...owners];
}

/** The sum of the shares that parse, in millionths. */
export function totalShares(owners: readonly OwnerInput[]): number {
  return owners.reduce((sum, owner) => sum + (parseShare(owner.share) ?? 0), 0);
}

/** One line to recognise a property by: "Rua das Flores, 120, apto 12". */
export function addressLine(a: PropertyAddress): string {
  return [a.street, a.number, a.complement].filter((part) => part.trim() !== "").join(", ");
}

/** "Centro, Bebedouro/SP". */
export function addressPlace(a: PropertyAddress): string {
  const city = a.state === "" ? a.city : `${a.city}/${a.state}`;
  return [a.district, city].filter((part) => part.trim() !== "").join(", ");
}

export function validateProperty(p: PropertyInput): FieldError[] {
  const problems: FieldError[] = addressLineProblems(p.address, "address.");
  const add = (field: string, message: string) => problems.push({ field, message });

  if (p.owners.length === 0) {
    add("owners", "Informe ao menos um proprietário.");
    return problems;
  }
  if (p.owners.length > MAX_OWNERS) add("owners", `Informe no máximo ${MAX_OWNERS} proprietários.`);
  // A single owner holds the whole property; there is no share to check.
  if (p.owners.length === 1) return problems;

  let allParse = true;
  p.owners.forEach((owner, i) => {
    const share = parseShare(owner.share);
    if (share === null) {
      allParse = false;
      add(`owners[${i}].share`, "Use um percentual como 50 ou 33,3333.");
    } else if (share <= 0 || share > FULL_SHARE) {
      allParse = false;
      add(`owners[${i}].share`, "A parte fica entre 0 e 100.");
    }
  });
  if (allParse) {
    const total = totalShares(p.owners);
    if (total !== FULL_SHARE) add("owners", `As partes somam ${formatShare(total)}%. Precisam somar 100%.`);
  }
  return problems;
}

/** The API's messages for what only it checks, in Portuguese. */
export function translatePropertyProblem(problem: FieldError): FieldError {
  const known: Record<string, string> = {
    "names a person that does not exist": "Essa pessoa não existe mais no escritório.",
    "must not repeat a person": "Essa pessoa já está na lista de proprietários.",
    "shares must add up to exactly 100": "As partes precisam somar 100%.",
  };
  return { field: problem.field, message: known[problem.message] ?? "Valor não aceito. Confira este campo." };
}
