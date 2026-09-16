/**
 * Authentication, exposed to the browser as server functions.
 *
 * These are the only way the interface reaches the API. Tokens never cross
 * this line: what goes back to the page is an account, never a credential.
 *
 * Expected failures come back as a `Result` rather than as a thrown error; see
 * `application/result.ts` for why.
 */

import { createServerFn } from "@tanstack/react-start";

import type { CurrentAccount } from "../application/ports.ts";
import { attempt, type Result } from "../application/result.ts";
import { fieldError } from "../domain/errors.ts";
import {
  validateEmail,
  validateRegistration,
  validateSecondFactorCode,
  type Membership,
  type Organization,
  type Role,
  type User,
} from "../domain/user.ts";
import { createCookieSessionStore } from "../infrastructure/session/cookie-session-store.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

/** The version of the terms an account agrees to when it is created. */
export const TERMS_VERSION = "1.0";

/** What the interface knows about the person signed in. */
export interface CurrentUser {
  readonly user: User;
  readonly organization: Organization;
  readonly role: Role;
  readonly mfaEnrollmentRequired: boolean;
}

export interface RegisterInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly organizationName: string;
  readonly acceptedTerms: boolean;
}

/**
 * Creates an account and the office it administers.
 *
 * It does not sign anyone in: the API separates the two deliberately, and the
 * interface sends the person to the sign-in screen next. The answer is the
 * same whether or not the address was already taken.
 */
export const register = createServerFn({ method: "POST" })
  .validator((input: RegisterInput) => input)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();

      // Validating here spares a round trip. The API validates independently
      // and remains the authority; this never relaxes a rule.
      const invalid = validateRegistration(data);
      if (invalid) throw invalid;

      await api().identity.register(callContext(), {
        email: data.email.trim(),
        name: data.name.trim(),
        password: data.password,
        organizationName: data.organizationName.trim(),
        termsVersion: TERMS_VERSION,
      });
      return null;
    }),
  );

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  readonly organizationId?: string | undefined;
}

/**
 * What a sign-in attempt earns.
 *
 * Either the session is open, or the second factor is still missing and the
 * screen asks for a code. The challenge crosses this line because the browser
 * has to send it back with the code, and it is useless without one.
 */
export type SignInResult =
  | { readonly kind: "signed_in"; readonly user: CurrentUser }
  | {
      readonly kind: "second_factor";
      readonly challenge: string;
      readonly organizations: readonly Membership[];
    };

/** Exchanges credentials for a session and seals it into the cookie. */
export const signIn = createServerFn({ method: "POST" })
  .validator((input: SignInInput) => input)
  .handler(async ({ data }): Promise<Result<SignInResult>> =>
    attempt(async () => {
      assertSameOrigin();

      const email = data.email.trim();
      const invalidEmail = validateEmail(email);
      if (invalidEmail) throw fieldError(invalidEmail.field, invalidEmail.message);
      if (data.password === "") throw fieldError("password", "Informe sua senha.");

      const outcome = await api().identity.signIn(callContext(), {
        email,
        password: data.password,
        organizationId: data.organizationId,
      });

      if (outcome.kind === "second_factor") {
        return {
          kind: "second_factor" as const,
          challenge: outcome.challenge,
          organizations: outcome.organizations,
        };
      }

      await sessions().signIn(outcome.session);
      return { kind: "signed_in" as const, user: currentUserOf(outcome.session) };
    }),
  );

export interface SecondFactorInput {
  readonly challenge: string;
  readonly code: string;
  readonly organizationId?: string | undefined;
}

/** Finishes a sign-in with a code from the app, or a recovery code. */
export const completeSecondFactor = createServerFn({ method: "POST" })
  .validator((input: SecondFactorInput) => input)
  .handler(async ({ data }): Promise<Result<CurrentUser>> =>
    attempt(async () => {
      assertSameOrigin();

      const invalid = validateSecondFactorCode(data.code);
      if (invalid) throw invalid;
      if (data.challenge === "") {
        throw fieldError("code", "A sessão expirou. Entre novamente.");
      }

      const session = await api().identity.completeSecondFactor(callContext(), {
        challenge: data.challenge,
        code: data.code.trim(),
        organizationId: data.organizationId,
      });
      await sessions().signIn(session);
      return currentUserOf(session);
    }),
  );

/** Ends the session at the API and clears the cookie either way. */
export const signOut = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      await sessions().signOut(callContext());
      return null;
    }),
);

/**
 * Who is signed in, read from the cookie alone.
 *
 * The guards call this on every navigation, so it must not cost a round trip
 * to the API. A cookie whose tokens are already dead still reads as a session
 * here; the first real call then fails and the screen offers a way back to
 * sign-in, which is a step rather than a dead end.
 */
export const currentUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<CurrentUser | null> => {
    const session = await createCookieSessionStore().read();
    return session === null ? null : currentUserOf(session);
  },
);

/** Everything the settings screen shows about the account, from the API. */
export const account = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<CurrentAccount>> =>
    attempt(async () => {
      const manager = sessions();
      return manager.authorize(callContext(), (ctx) => api().identity.me(ctx));
    }),
);

/** Moves the session to another office the same account belongs to. */
export const switchOrganization = createServerFn({ method: "POST" })
  .validator((organizationId: string) => organizationId)
  .handler(async ({ data }): Promise<Result<CurrentUser>> =>
    attempt(async () => {
      assertSameOrigin();

      const store = createCookieSessionStore();
      const current = await store.read();
      if (current === null) throw fieldError("request", "Sua sessão expirou.");

      const session = await api().identity.switchOrganization(callContext(), {
        refreshToken: current.refreshToken,
        organizationId: data,
      });
      await store.write(session);
      return currentUserOf(session);
    }),
  );

function currentUserOf(session: {
  user: User;
  organization: Organization;
  role: Role;
  mfaEnrollmentRequired: boolean;
}): CurrentUser {
  return {
    user: session.user,
    organization: session.organization,
    role: session.role,
    mfaEnrollmentRequired: session.mfaEnrollmentRequired,
  };
}
