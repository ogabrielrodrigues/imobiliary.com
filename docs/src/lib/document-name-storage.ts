/**
 * Which field completes a document's name, remembered per template.
 *
 * One localStorage record: a map from template id to the encoded choice, such
 * as "field:locatario_nome". It holds the name of a field, never a value typed
 * into one, and it never leaves the browser. The privacy policy lists it
 * (section 5).
 */

import {
  decodeNameSource,
  encodeNameSource,
  type NameSource,
} from "../domain/document-name.ts";

export const DOCUMENT_NAME_STORAGE_KEY = "imobiliary_docs_document_name";

/** A browser that keeps nothing still works; this only spares a choice. */
function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(DOCUMENT_NAME_STORAGE_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The remembered choice for a template, if it still fits its placeholders. */
export function loadNameSource(
  templateId: string,
  placeholders: readonly string[],
): NameSource | null {
  return decodeNameSource(readAll()[templateId], placeholders);
}

export function saveNameSource(templateId: string, source: NameSource): void {
  try {
    localStorage.setItem(
      DOCUMENT_NAME_STORAGE_KEY,
      JSON.stringify({ ...readAll(), [templateId]: encodeNameSource(source) }),
    );
  } catch {
    // Storage blocked or full: the choice simply is not remembered.
  }
}
