import { ValidationError, type FieldError } from "./errors.ts";

/** The API's ceiling on a single substituted value, in bytes. */
export const MAX_VALUE_LENGTH = 10_000;

/**
 * A rendered document.
 *
 * There is no lifecycle here on purpose: generation is synchronous, so a
 * document either exists or the request failed. It is never a draft, never
 * pending, never archived, and a failure is never a row.
 */
export interface GeneratedDocument {
  readonly id: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly filename: string;
  readonly size: number;
  /** The values used, retained so the output can be reproduced. */
  readonly data: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  /** Path to the download endpoint, relative to the API. */
  readonly downloadUrl: string;
  /** The batch it was generated in, or null for one generated on its own. */
  readonly batchId: string | null;
}

export interface GenerateInput {
  readonly templateId: string;
  /** Pins a template version. Omit to use the latest. */
  readonly version?: number;
  readonly filename?: string;
  readonly data: Readonly<Record<string, string>>;
  /** Joins the document to a batch of the same template. */
  readonly batchId?: string;
}

/**
 * Checks the values against a version's placeholder schema.
 *
 * The keys must match exactly. A missing key and an unrecognised key are both
 * errors, and every problem is reported at once — rejecting unknown keys is
 * deliberate, because silently dropping a misspelled one would hand back a
 * document missing text the user believed they had supplied.
 *
 * Field names are prefixed `data.<placeholder>`, matching how the API names
 * them, so one rendering of an error list serves both sources.
 */
export function validateDocumentData(
  placeholders: readonly string[],
  data: Readonly<Record<string, string>>,
): ValidationError | null {
  const fields: FieldError[] = [];
  const known = new Set(placeholders);

  for (const name of placeholders) {
    const value = data[name];
    if (value === undefined || value.trim() === "") {
      fields.push({
        field: `data.${name}`,
        message: "Este campo é obrigatório.",
      });
    }
  }

  for (const [name, value] of Object.entries(data)) {
    if (!known.has(name)) {
      fields.push({
        field: `data.${name}`,
        message: "Este campo não existe nesta versão do modelo.",
      });
      continue;
    }
    // Measured in UTF-8 bytes, which is the unit the API's limit is in.
    if (new TextEncoder().encode(value).length > MAX_VALUE_LENGTH) {
      fields.push({
        field: `data.${name}`,
        message: `O valor deve ter no máximo ${MAX_VALUE_LENGTH} caracteres.`,
      });
    }
  }

  return fields.length > 0 ? new ValidationError(fields) : null;
}

/** How many placeholders already have a value, for the checklist. */
export function countFilled(
  placeholders: readonly string[],
  data: Readonly<Record<string, string>>,
): number {
  return placeholders.filter((name) => (data[name] ?? "").trim() !== "").length;
}

/**
 * Suggests a filename from the template's name.
 *
 * The API sanitises whatever it is given, so this only has to be reasonable,
 * not safe.
 */
export function suggestFilename(templateName: string): string {
  const slug = templateName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${slug === "" ? "documento" : slug}.docx`;
}
