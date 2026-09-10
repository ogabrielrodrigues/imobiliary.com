import { ValidationError, type FieldError } from "./errors.ts";

/**
 * Account limits, kept in step with the API's own.
 *
 * Validating here is a courtesy to the user — it turns a round trip into
 * instant feedback. It is never a security control: the API validates
 * independently and is the only authority. Never relax a rule here to make a
 * form easier; relax it in the API or not at all.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
export const MAX_NAME_LENGTH = 120;
export const MAX_EMAIL_LENGTH = 254;

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** The credential pair a session is made of. */
export interface Session {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  readonly user: User;
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

export interface RegistrationInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
  /**
   * The version of the terms of use the person accepted.
   *
   * Carried explicitly rather than assumed by the server: what was agreed to
   * is a property of the screen the person actually read.
   */
  readonly termsVersion: string;
}

/**
 * Checks a registration form, returning every problem at once.
 *
 * Returns null when the input is acceptable, so a caller can write
 * `const invalid = validateRegistration(input); if (invalid) …`.
 */
export function validateRegistration(
  input: RegistrationInput,
): ValidationError | null {
  const fields: FieldError[] = [];
  const email = normalizeEmail(input.email);

  if (email === "") {
    fields.push({ field: "email", message: "Informe seu e-mail." });
  } else if (email.length > MAX_EMAIL_LENGTH) {
    fields.push({
      field: "email",
      message: `O e-mail deve ter no máximo ${MAX_EMAIL_LENGTH} caracteres.`,
    });
  } else if (!looksLikeEmail(email)) {
    fields.push({ field: "email", message: "Esse e-mail não parece válido." });
  }

  const name = input.name.trim();
  if (name === "") {
    fields.push({ field: "name", message: "Informe seu nome." });
  } else if ([...name].length > MAX_NAME_LENGTH) {
    fields.push({
      field: "name",
      message: `O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`,
    });
  }

  fields.push(...validatePassword(input.password));

  return fields.length > 0 ? new ValidationError(fields) : null;
}

/**
 * Length is the only password rule, following the same guidance the API does:
 * length beats composition, so there is no demand for symbols or digits.
 *
 * Counted in characters rather than bytes, so a passphrase using accents is
 * not credited with more length than it has.
 */
function validatePassword(password: string): FieldError[] {
  const length = [...password].length;

  if (password === "") {
    return [{ field: "password", message: "Escolha uma senha." }];
  }
  if (length < MIN_PASSWORD_LENGTH) {
    return [
      {
        field: "password",
        message: `A senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      },
    ];
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return [
      {
        field: "password",
        message: `A senha deve ter no máximo ${MAX_PASSWORD_LENGTH} caracteres.`,
      },
    ];
  }
  return [];
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

/**
 * Checks a login form for emptiness only.
 *
 * It deliberately does not apply the password rules: an account created before
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
