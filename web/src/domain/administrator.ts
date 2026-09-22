/**
 * Who administers the office's rentals, as the receipts name it: a person,
 * a self-employed broker with a CPF, or a company with a CNPJ, and the CRECI.
 * Mirrors `Administrator` in `internal/domain/organization.go`.
 */

import type { FieldError } from "./errors.ts";
import { isValidCNPJ, isValidCPF } from "./person.ts";

export type AdministratorKind = "individual" | "company";

export interface Administrator {
  readonly kind: AdministratorKind;
  /** A CPF or a CNPJ, as typed or as the API returns it, formatted. */
  readonly document: string;
  readonly creci: string;
}

export const ADMINISTRATOR_KINDS: readonly (readonly [AdministratorKind, string])[] = [
  ["individual", "Pessoa física (corretor autônomo)"],
  ["company", "Pessoa jurídica (imobiliária)"],
];

export const MAX_CRECI_LENGTH = 30;

export function emptyAdministrator(): Administrator {
  return { kind: "individual", document: "", creci: "" };
}

export function validateAdministrator(a: Administrator): FieldError[] {
  const problems: FieldError[] = [];
  if (a.kind === "individual" && !isValidCPF(a.document)) {
    problems.push({ field: "document", message: "Informe um CPF válido." });
  }
  if (a.kind === "company" && !isValidCNPJ(a.document)) {
    problems.push({ field: "document", message: "Informe um CNPJ válido." });
  }
  if (a.creci.trim().length > MAX_CRECI_LENGTH) {
    problems.push({ field: "creci", message: `Use no máximo ${MAX_CRECI_LENGTH} caracteres.` });
  }
  return problems;
}

/** The API's refusals, in Portuguese. */
export function translateAdministratorProblem(problem: FieldError): FieldError {
  const known: Record<string, string> = {
    "is not a valid CPF": "Informe um CPF válido.",
    "is not a valid CNPJ": "Informe um CNPJ válido.",
    "must be individual or company": "Escolha pessoa física ou jurídica.",
  };
  return { field: problem.field, message: known[problem.message] ?? "Valor não aceito. Confira este campo." };
}
