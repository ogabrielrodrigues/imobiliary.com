import type { GeneratedDocument } from "./document.ts";

/**
 * A batch: documents generated together from one template version, typically
 * one per row of a spreadsheet. The history shows it as one entry, and it
 * downloads as one archive.
 */
export interface Batch {
  readonly id: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly name: string;
  /** Documents generated in it so far. */
  readonly documents: number;
  /** Their total size in bytes. */
  readonly size: number;
  readonly createdAt: Date;
  readonly downloadUrl: string;
}

/** The API's cap on a batch's name, in characters. */
export const MAX_BATCH_NAME_LENGTH = 120;

/** One entry of the generation history. */
export type HistoryEntry =
  | { readonly kind: "document"; readonly document: GeneratedDocument }
  | { readonly kind: "batch"; readonly batch: Batch };

/** "1 documento", "48 documentos". */
export function batchCount(documents: number): string {
  return `${documents} ${documents === 1 ? "documento" : "documentos"}`;
}
