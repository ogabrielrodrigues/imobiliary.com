import { ValidationError, type FieldError } from "./errors.ts";

export const MAX_TEMPLATE_NAME_LENGTH = 120;
export const MAX_TEMPLATE_DESCRIPTION_LENGTH = 500;

/** The default upload ceiling the API applies, in bytes. */
export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;

export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * An immutable snapshot of an uploaded .docx.
 *
 * Publishing a change appends a version rather than altering this one, which is
 * what keeps a document generated months ago reproducible today.
 */
export interface TemplateVersion {
  readonly id: string;
  readonly version: number;
  readonly size: number;
  /** The fields the document declares, sorted. This is the schema to satisfy. */
  readonly placeholders: readonly string[];
  readonly createdAt: Date;
}

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly latestVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Present when a single template was fetched; absent in listings. */
  readonly version?: TemplateVersion;
}

export interface TemplateUploadInput {
  readonly name: string;
  readonly description: string;
  readonly file: File;
}

/**
 * Checks an upload before it is sent.
 *
 * The archive itself is not inspected here: deciding whether a file is a valid
 * .docx, holds `word/document.xml` and uses an accepted placeholder grammar is
 * the API's job, and it does it properly. This only catches the mistakes worth
 * catching without a round trip.
 */
export function validateTemplateUpload(
  input: TemplateUploadInput,
): ValidationError | null {
  const fields = [...validateTemplateDetails(input), ...validateTemplateFile(input.file)];
  return fields.length > 0 ? new ValidationError(fields) : null;
}

/**
 * The name and description rules alone, shared by the upload and by a template
 * written in the block editor, which has no file until it is saved.
 */
export function validateTemplateDetails(input: {
  readonly name: string;
  readonly description: string;
}): FieldError[] {
  const fields: FieldError[] = [];

  const name = input.name.trim();
  if (name === "") {
    fields.push({ field: "name", message: "Dê um nome ao modelo." });
  } else if ([...name].length > MAX_TEMPLATE_NAME_LENGTH) {
    fields.push({
      field: "name",
      message: `O nome deve ter no máximo ${MAX_TEMPLATE_NAME_LENGTH} caracteres.`,
    });
  }

  if ([...input.description].length > MAX_TEMPLATE_DESCRIPTION_LENGTH) {
    fields.push({
      field: "description",
      message: `A descrição deve ter no máximo ${MAX_TEMPLATE_DESCRIPTION_LENGTH} caracteres.`,
    });
  }

  return fields;
}

/** Checks the chosen file's shape and size. */
export function validateTemplateFile(file: File): FieldError[] {
  if (file.size === 0) {
    return [{ field: "file", message: "Escolha um arquivo .docx." }];
  }
  if (file.size > MAX_TEMPLATE_BYTES) {
    return [
      {
        field: "file",
        message: `O arquivo deve ter no máximo ${formatBytes(MAX_TEMPLATE_BYTES)}.`,
      },
    ];
  }
  // The extension is checked rather than the browser-reported media type,
  // which is unreliable and, on some systems, empty for .docx entirely.
  if (!file.name.toLowerCase().endsWith(".docx")) {
    return [
      {
        field: "file",
        message: "O modelo precisa ser um arquivo .docx do Word.",
      },
    ];
  }
  return [];
}

/** Lowercased and stripped of accents, so "Locação" and "locacao" match. */
function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/**
 * Whether a template matches what someone typed in the search box.
 *
 * Every word must appear somewhere in the name or the description, in any
 * order, ignoring case and accents: "aditamento locacao" finds "Aditamento de
 * contrato de locação". An empty query matches everything.
 */
export function matchesTemplateSearch(template: Template, query: string): boolean {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const haystack = foldForSearch(`${template.name} ${template.description}`);
  return words.every((word) => haystack.includes(word));
}

/** Renders a byte count the way the interface shows it, e.g. "1,2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["kB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const rendered = value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${rendered.replace(".", ",")} ${units[unit]}`;
}
