/**
 * Documents generated from a lease, and the templates they come from.
 *
 * The document service holds both; this platform names each generated document
 * after the contract it belongs to, so a contract can list its own papers
 * without the service knowing anything about leases.
 */

/** How a document says which record it belongs to. */
export function contractReference(contractId: string): string {
  return `contract:${contractId}`;
}

/** One value a template asks for, as the contract answers it. */
export interface DocumentField {
  readonly name: string;
  readonly value: string;
}

export interface TemplateVersion {
  readonly version: number;
  readonly placeholders: readonly string[];
}

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly latestVersion: number;
  readonly version?: TemplateVersion | undefined;
}

export interface GeneratedDocument {
  readonly id: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly filename: string;
  readonly size: number;
  readonly createdAt: Date;
  readonly reference: string;
}

/** What a generation needs: which template, what to call it, and the values. */
export interface GenerateInput {
  readonly templateId: string;
  readonly version?: number | undefined;
  readonly filename: string;
  readonly data: Readonly<Record<string, string>>;
  readonly reference: string;
}

/**
 * The document service replaces anything other than a letter, a digit, a
 * space, a dot, a dash or an underscore with an underscore, and cuts the name
 * at 100 bytes. Cleaning a suggestion the same way is what makes the name the
 * office sees the name that is stored.
 */
export function cleanDocumentName(name: string): string {
  const cleaned = name.replace(/[^\p{L}\p{N} ._-]/gu, "_").trim();
  const bytes = new TextEncoder().encode(cleaned);
  if (bytes.length <= 100) return cleaned;

  // Cut on a character boundary: slicing bytes could split one in half.
  return new TextDecoder().decode(bytes.slice(0, 100)).replace(/�$/, "").trim();
}

/**
 * The name to suggest for a lease's document: the template, the contract and
 * the tenant, which is how an office looks for one afterwards.
 */
export function suggestDocumentName(parts: {
  readonly template: string;
  readonly contractRegistry: string;
  readonly tenant: string;
}): string {
  const pieces = [parts.template, parts.contractRegistry, parts.tenant]
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "");
  return cleanDocumentName(pieces.join(" - "));
}

/**
 * Which fields the template asks for and the contract cannot answer.
 *
 * They are not an error: a template may ask for something this platform does
 * not know, such as a witness. The review shows them empty and says so, and
 * the person fills them in before generating.
 */
export function unknownPlaceholders(
  placeholders: readonly string[],
  fields: readonly DocumentField[],
): readonly string[] {
  const known = new Set(fields.map((field) => field.name));
  return placeholders.filter((name) => !known.has(name));
}

/** Which values are still empty, whatever their origin. */
export function emptyPlaceholders(
  placeholders: readonly string[],
  values: Readonly<Record<string, string>>,
): readonly string[] {
  return placeholders.filter((name) => (values[name] ?? "").trim() === "");
}
