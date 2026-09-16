/**
 * The people, the offices and the session, as this platform sees them.
 *
 * The rules repeated here are the API's own. They are not a second source of
 * truth: the API validates everything again, and a disagreement is settled in
 * its favour. What they buy is a form that says what is wrong before a round
 * trip, which is the difference between a password field that helps and one
 * that guesses.
 */

import { fieldError, ValidationError, type FieldError } from "./errors.ts";

/** The minimum the API enforces. The design system once said 8; it was wrong. */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_NAME_LENGTH = 120;
export const MAX_ORGANIZATION_NAME_LENGTH = 120;

/** What a member may do in an office. */
export type Role = "admin" | "member";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly totpEnabled: boolean;
}

export interface Organization {
  readonly id: string;
  readonly name: string;
}

export interface Membership {
  readonly organization: Organization;
  readonly role: Role;
}

/**
 * A signed-in session, as the cookie holds it.
 *
 * It carries the office it is working in, because every request the API serves
 * belongs to one, and the role, because the interface hides what a member may
 * not do rather than letting them meet a 403.
 */
export interface Session {
  readonly user: User;
  readonly organization: Organization;
  readonly role: Role;
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  /** An administrator who has not enrolled a second factor yet. */
  readonly mfaEnrollmentRequired: boolean;
}

/** What a sign-in earns: a session, or the challenge that asks for a code. */
export type SignInOutcome =
  | { readonly kind: "session"; readonly session: Session }
  | {
      readonly kind: "second_factor";
      readonly challenge: string;
      readonly organizations: readonly Membership[];
    };

export interface RegistrationInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly organizationName: string;
  readonly termsVersion: string;
}

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly organizationId?: string | undefined;
}

/** The invitation as the acceptance screen reads it, before anything is typed. */
export interface PendingInvitation {
  readonly organization: Organization;
  readonly email: string;
  readonly role: Role;
  readonly accountExists: boolean;
}

// --- the rules --------------------------------------------------------------

export function validateEmail(email: string): FieldError | null {
  const value = email.trim();
  if (value === "") return { field: "email", message: "Informe seu e-mail." };
  // Deliberately loose: the API decides, and a stricter pattern here would
  // reject addresses that are valid and rare.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { field: "email", message: "Esse e-mail não parece válido." };
  }
  return null;
}

export function validatePassword(password: string, field = "password"): FieldError | null {
  if (password === "") return { field, message: "Informe uma senha." };
  // Counted in characters, as the API counts runes: an accented passphrase
  // must not be credited with the extra bytes of its encoding.
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return { field, message: `A senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.` };
  }
  return null;
}

export function validateName(name: string, field = "name"): FieldError | null {
  const value = name.trim();
  if (value === "") return { field, message: "Informe seu nome." };
  if ([...value].length > MAX_NAME_LENGTH) {
    return { field, message: `Use no máximo ${MAX_NAME_LENGTH} caracteres.` };
  }
  return null;
}

export function validateOrganizationName(name: string): FieldError | null {
  const value = name.trim();
  if (value === "") return { field: "organization_name", message: "Informe o nome do escritório." };
  if ([...value].length > MAX_ORGANIZATION_NAME_LENGTH) {
    return {
      field: "organization_name",
      message: `Use no máximo ${MAX_ORGANIZATION_NAME_LENGTH} caracteres.`,
    };
  }
  return null;
}

/** Collects every problem, so a form lights up all its bad fields at once. */
export function validateRegistration(input: {
  email: string;
  name: string;
  password: string;
  organizationName: string;
  acceptedTerms: boolean;
}): ValidationError | null {
  const problems = [
    validateName(input.name),
    validateEmail(input.email),
    validateOrganizationName(input.organizationName),
    validatePassword(input.password),
    input.acceptedTerms ? null : { field: "terms", message: "É preciso aceitar os termos." },
  ].filter((problem): problem is FieldError => problem !== null);

  return problems.length === 0 ? null : new ValidationError(problems);
}

/** The code from the app, or a recovery code. */
export function validateSecondFactorCode(code: string): ValidationError | null {
  const value = code.trim();
  if (value === "") return fieldError("code", "Informe o código.");
  return null;
}
