/**
 * Who the controller is, and which version of each legal document is in force.
 *
 * The LGPD requires a controller to identify itself and to publish a channel
 * for its data protection officer (articles 9 and 41). That identity appears on
 * the privacy policy, on the terms, in the footer and in the cookie notice, so
 * it is stated once here and read everywhere else — a CNPJ that disagrees with
 * itself across four pages is worse than one that is missing.
 *
 * The values below are placeholders. They are written in a shape nothing can
 * mistake for real data, and `unfilledLegalFields` finds them, so the service
 * can refuse to start in production while any of them remain.
 */

/** A value still waiting to be filled in looks like this. */
const PLACEHOLDER_PATTERN = /\[[A-ZÀ-Ú][A-ZÀ-Ú\s/.-]*\]/;

export interface Controller {
  /** The registered company name. */
  readonly legalName: string;
  /** The name the product is known by. */
  readonly tradeName: string;
  readonly cnpj: string;
  readonly address: string;
  /** Where a data subject writes to exercise a right. */
  readonly privacyEmail: string;
  /** The data protection officer, article 41. */
  readonly officerName: string;
  readonly officerEmail: string;
}

export const CONTROLLER: Controller = {
  legalName: "[RAZÃO SOCIAL]",
  tradeName: "Imobiliary Docs",
  cnpj: "[CNPJ]",
  address: "[ENDEREÇO COMPLETO]",
  privacyEmail: "[E-MAIL DE PRIVACIDADE]",
  officerName: "[NOME DO ENCARREGADO]",
  officerEmail: "[E-MAIL DO ENCARREGADO]",
};

/**
 * A legal document and the version of it that is in force.
 *
 * The date is what a user is told they accepted, and what a later dispute turns
 * on, so it belongs beside the text rather than inside it.
 */
export interface LegalDocument {
  readonly title: string;
  /** Bumped whenever the text changes in a way that matters. */
  readonly version: string;
  /** ISO date, rendered for the reader in pt-BR. */
  readonly effectiveFrom: string;
}

export const PRIVACY_POLICY: LegalDocument = {
  title: "Política de Privacidade",
  // 1.1 names Resend as a processor and declares the international transfer
  // that sending a password-reset mail entails. The terms did not change, so
  // their version did not either. 1.4 lists the third local-storage record:
  // which field completes a document's name, per template.
  version: "1.4",
  effectiveFrom: "2026-09-14",
};

export const TERMS_OF_USE: LegalDocument = {
  title: "Termos de Uso",
  version: "1.0",
  effectiveFrom: "2026-09-10",
};

/** The terms version a new account is recorded as having accepted. */
export const CURRENT_TERMS_VERSION = TERMS_OF_USE.version;

/** Renders an ISO date the way the interface writes dates. */
export function formatEffectiveDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * The controller fields that are still placeholders.
 *
 * Returned rather than thrown so a caller decides what to do about it: the
 * production server refuses to start, while development shows the pages with
 * the brackets visible, which is the fastest way to see what is missing.
 */
export function unfilledLegalFields(
  controller: Controller = CONTROLLER,
): string[] {
  return Object.entries(controller)
    .filter(([, value]) => PLACEHOLDER_PATTERN.test(value))
    .map(([field]) => field);
}

/**
 * Refuses to continue while the controller is unidentified.
 *
 * Called at startup in production, following the same rule the session secret
 * follows: a deployment that forgot is stopped at the door rather than serving
 * a privacy policy addressed to nobody.
 */
export function assertLegalIdentityComplete(
  controller: Controller = CONTROLLER,
): void {
  const missing = unfilledLegalFields(controller);
  if (missing.length === 0) return;

  throw new Error(
    "The controller identity is still a placeholder in " +
      `src/domain/legal.ts: ${missing.join(", ")}. ` +
      "The privacy policy and the terms name the controller and its data " +
      "protection officer, so these must be real before this is served.",
  );
}
