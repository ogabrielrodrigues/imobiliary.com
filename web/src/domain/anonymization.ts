/**
 * Anonymisation at the end of the legal retention (PLANO-PENDENCIAS.md §4).
 * Mirrors `internal/usecase/anonymization.go`: the API decides who is past
 * the retention; this module names the result and translates refusals.
 */

import type { FieldError } from "./errors.ts";
import type { PersonRef } from "./payout.ts";

export interface AnonymizationCandidate {
  readonly person: PersonRef;
  /** The last contract end, ledger line or payout. */
  readonly lastActivityOn: string;
  /** The first day the record could be anonymised. */
  readonly retentionEndedOn: string;
  readonly contracts: readonly {
    readonly id: string;
    readonly registry: string;
    /** Every other party is anonymised too, or is a candidate: the contract's documents can go. */
    readonly documentsCanGo: boolean;
  }[];
  readonly payouts: readonly { readonly id: string; readonly number: string }[];
}

/** What confirming did in the document service. */
export interface AnonymizationResult {
  readonly documentsDeleted: number;
  /** Documents of contracts whose other parties are still registered. */
  readonly documentsKept: number;
}

export function translateAnonymizationProblem(problem: FieldError): FieldError {
  const known: Record<string, string> = {
    "is not due for anonymization": "Esta pessoa não está mais entre as que podem ser anonimizadas. Recarregue a página.",
  };
  return { field: "form", message: known[problem.message] ?? "Não foi possível anonimizar. Recarregue a página." };
}
