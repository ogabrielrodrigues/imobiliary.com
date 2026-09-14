import type { FieldError } from "./errors.ts";

/**
 * Naming a generated document.
 *
 * The API keeps a filename to 100 bytes, adds ".docx", and silently turns any
 * character other than a letter, digit, space, ".", "-" or "_" into "_". The
 * rules here mirror that so the name a person sees before generating is the
 * name that gets stored: suggestions are cleaned the same way, and a typed name
 * with a character the API would replace is reported rather than altered.
 */

/** The API's cap on the stored name, before ".docx", in UTF-8 bytes. */
export const MAX_DOCUMENT_NAME_BYTES = 100;

const DOCX = ".docx";

/** What completes the template's name in a suggestion. */
export type NameSource =
  | { readonly kind: "field"; readonly name: string }
  | { readonly kind: "date" }
  | { readonly kind: "none" };

/** Characters the API would replace. */
const DISALLOWED = /[^\p{L}\p{N} ._-]/gu;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * The field a name is completed with when nothing was chosen yet: the first
 * placeholder that holds a name ("locatario_nome", or just "nome"), since that
 * is what tells two documents from the same template apart. Without one, the
 * date.
 */
export function defaultNameSource(placeholders: readonly string[]): NameSource {
  const name = placeholders.find((p) => p === "nome" || p.endsWith("_nome"));
  return name === undefined ? { kind: "date" } : { kind: "field", name };
}

/** "14-09-2026". Slashes would become "_" in the API. */
export function dateForName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

/**
 * Removes what the API would replace, collapses spaces, and cuts to the byte
 * limit without splitting a character.
 */
export function cleanDocumentName(name: string): string {
  let clean = name.replace(DISALLOWED, " ").replace(/\s+/g, " ").trim();
  while (bytes(clean) > MAX_DOCUMENT_NAME_BYTES) {
    clean = [...clean].slice(0, -1).join("").trimEnd();
  }
  return clean;
}

/**
 * The suggested name: "<template> - <completion>".
 *
 * A chosen field that is still empty falls back to the date, so a suggestion is
 * never just the template's name repeated across every document.
 */
export function suggestDocumentName(
  templateName: string,
  source: NameSource,
  values: Readonly<Record<string, string>>,
  today: Date,
): string {
  const completion =
    source.kind === "none"
      ? ""
      : source.kind === "date"
        ? dateForName(today)
        : (values[source.name] ?? "").trim() || dateForName(today);

  const base = cleanDocumentName(templateName) || "Documento";
  return cleanDocumentName(completion === "" ? base : `${base} - ${completion}`);
}

/** Problems with a name typed by hand, on the field "filename". */
export function validateDocumentName(name: string): FieldError[] {
  const trimmed = name.trim();
  if (trimmed === "") {
    return [{ field: "filename", message: "Dê um nome ao documento." }];
  }
  if (new RegExp(DISALLOWED.source, "u").test(trimmed)) {
    return [
      {
        field: "filename",
        message: "Use apenas letras, números, espaços, ponto, hífen e sublinhado.",
      },
    ];
  }
  if (bytes(withoutDocx(trimmed)) > MAX_DOCUMENT_NAME_BYTES) {
    return [{ field: "filename", message: "O nome está longo demais. Encurte um pouco." }];
  }
  return [];
}

function withoutDocx(name: string): string {
  return name.toLowerCase().endsWith(DOCX) ? name.slice(0, -DOCX.length) : name;
}

/** The name as sent to the API, with the extension it will have anyway. */
export function toFilename(name: string): string {
  const trimmed = name.trim();
  return trimmed.toLowerCase().endsWith(DOCX) ? trimmed : `${trimmed}${DOCX}`;
}

/** A stored filename as a person reads it: without the extension. */
export function displayName(filename: string): string {
  return withoutDocx(filename);
}

/** Serialised form of a source, for a select value and for storage. */
export function encodeNameSource(source: NameSource): string {
  return source.kind === "field" ? `field:${source.name}` : source.kind;
}

/**
 * The inverse of `encodeNameSource`, checked against the template's current
 * placeholders: a field that no longer exists in this version is no choice at
 * all, and the caller falls back to the default.
 */
export function decodeNameSource(
  encoded: unknown,
  placeholders: readonly string[],
): NameSource | null {
  if (encoded === "date") return { kind: "date" };
  if (encoded === "none") return { kind: "none" };
  if (typeof encoded === "string" && encoded.startsWith("field:")) {
    const name = encoded.slice("field:".length);
    return placeholders.includes(name) ? { kind: "field", name } : null;
  }
  return null;
}
