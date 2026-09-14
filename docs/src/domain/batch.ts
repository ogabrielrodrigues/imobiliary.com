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

/** The most rows one batch generates. At the API's write rate, about two minutes. */
export const MAX_BATCH_ROWS = 200;

/** Words that carry no meaning in a column header: "nome do locatário". */
const FILLER = new Set(["a", "as", "o", "os", "de", "da", "das", "do", "dos", "e", "em", "na", "no"]);

/**
 * A header or a placeholder as a set of meaningful words: no accents, no case,
 * no punctuation, no filler words, in no particular order. "Nome do
 * locatário", "Locatario - Nome" and `locatario_nome` all come out the same.
 */
export function headerWords(text: string): string {
  const words = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "" && !FILLER.has(word));
  return [...new Set(words)].sort().join(" ");
}

/**
 * Which column feeds each placeholder, guessed from the headers: the first
 * column whose words are the placeholder's words. A column is used once. What
 * finds no column stays null for the person to choose.
 */
export function matchColumns(
  placeholders: readonly string[],
  headers: readonly string[],
): Record<string, number | null> {
  const headerKeys = headers.map(headerWords);
  const taken = new Set<number>();
  const out: Record<string, number | null> = {};

  for (const name of placeholders) {
    const key = headerWords(name);
    const index = headerKeys.findIndex((header, i) => header === key && !taken.has(i));
    out[name] = index === -1 ? null : index;
    if (index !== -1) taken.add(index);
  }
  return out;
}

/** The values one row supplies, by placeholder. An unmatched field is empty. */
export function rowData(
  placeholders: readonly string[],
  columns: Readonly<Record<string, number | null>>,
  row: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    placeholders.map((name) => {
      const index = columns[name];
      return [name, index === null || index === undefined ? "" : (row[index] ?? "")];
    }),
  );
}
