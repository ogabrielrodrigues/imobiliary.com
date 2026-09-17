import { ValidationError, type FieldError } from "./errors.ts";

/**
 * Who a signed-in person is, and the rules this platform checks before asking
 * the Imobiliary platform anything.
 *
 * Accounts, passwords and second factors belong to the Imobiliary platform:
 * this one signs a person in against it and holds the session, so there is no
 * sign-up, no password rule and no recovery here. What is left is the sign-in
 * form's own emptiness checks, which only spare a round trip.
 */
export const MAX_EMAIL_LENGTH = 254;

export type Role = "admin" | "member";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** The office a session works in. Templates and documents belong to it. */
export interface Organization {
  readonly id: string;
  readonly name: string;
}

/** One office an account belongs to, with the role it holds there. */
export interface Membership {
  readonly organization: Organization;
  readonly role: Role;
}

/**
 * A signed-in session, as the cookie holds it.
 *
 * The tokens are the Imobiliary platform's. A call to the document service
 * carries a short token minted from this session instead, so what is stored
 * here is never sent to the document service.
 */
export interface Session {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  readonly user: User;
  readonly organization: Organization;
  readonly role: Role;
}

/**
 * Lowercases and trims an address the way the API does, so the value shown
 * back to the user matches the one that was stored.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A deliberately permissive address check: one @, something either side, no
 * spaces. Anything stricter rejects addresses that are in fact valid, and the
 * API — which parses properly — has the final say regardless.
 */
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function emailProblems(input: string): FieldError[] {
  const email = normalizeEmail(input);

  if (email === "") {
    return [{ field: "email", message: "Informe seu e-mail." }];
  }
  if (email.length > MAX_EMAIL_LENGTH) {
    return [
      {
        field: "email",
        message: `O e-mail deve ter no máximo ${MAX_EMAIL_LENGTH} caracteres.`,
      },
    ];
  }
  if (!looksLikeEmail(email)) {
    return [{ field: "email", message: "Esse e-mail não parece válido." }];
  }
  return [];
}

/** Checks an address on its own. */
export function validateEmail(email: string): ValidationError | null {
  const fields = emailProblems(email);
  return fields.length > 0 ? new ValidationError(fields) : null;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

/**
 * Checks a login form for emptiness only.
 *
 * It deliberately does not apply any password rule: an account created before
 * a rule changed must still be able to sign in, and telling the user their
 * password is "too short" at the login screen leaks how the stored one looks.
 */
export function validateLogin(input: LoginInput): ValidationError | null {
  const fields: FieldError[] = [];

  if (normalizeEmail(input.email) === "") {
    fields.push({ field: "email", message: "Informe seu e-mail." });
  }
  if (input.password === "") {
    fields.push({ field: "password", message: "Informe sua senha." });
  }

  return fields.length > 0 ? new ValidationError(fields) : null;
}

/**
 * Checks the second-factor step for emptiness.
 *
 * The length is not checked: a code from the app has six digits and a recovery
 * code does not, and only the platform knows which was given.
 */
export function validateSecondFactorCode(code: string): ValidationError | null {
  if (code.trim() === "") {
    return new ValidationError([{ field: "code", message: "Informe o código." }]);
  }
  return null;
}
