/**
 * Signing in, exposed to the browser as server functions.
 *
 * These are the only way the interface reaches either API. Tokens never cross
 * this line: what goes back to the page is an account, never a credential.
 *
 * Identity belongs to the Imobiliary platform. A person signs in here with
 * their Imobiliary account, and the session this holds is that platform's; the
 * document service is called with a short token minted from it. Creating an
 * account, changing a password and enrolling a second factor happen on the
 * platform, which `platformLinks` points at.
 *
 * Expected failures come back as a `Result` rather than as a thrown error — see
 * `application/result.ts` for why.
 */

import { createServerFn } from "@tanstack/react-start";

import type { Caller, FileContent } from "../application/ports.ts";
import { attempt, type Result } from "../application/result.ts";
import { fieldError } from "../domain/errors.ts";
import type { Membership, Organization, Role, User } from "../domain/user.ts";
import {
  validateLogin,
  validateSecondFactorCode,
  type LoginInput,
} from "../domain/user.ts";
import { getConfig } from "../infrastructure/config.ts";
import { assertSameOrigin, callContext, docgen, identity, sessions } from "./runtime.ts";

/** What the interface knows about the person signed in. */
export interface CurrentUser {
  readonly user: User;
  readonly organization: Organization;
  readonly role: Role;
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

/** Exchanges Imobiliary credentials for a session and seals it into the cookie. */
export const login = createServerFn({ method: "POST" })
  .validator((input: LoginInput) => input)
  .handler(async ({ data }): Promise<Result<SignInResult>> =>
    attempt(async () => {
      assertSameOrigin();

      const invalid = validateLogin(data);
      if (invalid) throw invalid;

      const outcome = await identity().signIn(callContext(), {
        email: data.email.trim(),
        password: data.password,
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

      const session = await identity().completeSecondFactor(callContext(), {
        challenge: data.challenge,
        code: data.code.trim(),
      });
      await sessions().signIn(session);
      return currentUserOf(session);
    }),
  );

/** Ends the session here and at the platform. */
export const logout = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      await sessions().signOut(callContext());
      return null;
    }),
);

/**
 * The signed-in account, or null.
 *
 * Reading the cookie is enough: the account it carries was put there by the
 * platform at sign-in, and asking again on every page load would spend a
 * request to learn something already known.
 *
 * This one returns a bare value rather than a Result — a visitor who is not
 * signed in is an ordinary answer, not a failure.
 */
export const currentUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<CurrentUser | null> => {
    const session = await sessions().current();
    return session === null ? null : currentUserOf(session);
  },
);

/**
 * Who the document service says the token speaks for.
 *
 * It is the one call that proves the whole chain works: the session refreshes,
 * the platform mints a token, and the document service accepts it and answers
 * with the office it belongs to.
 */
export const currentCaller = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<Caller>> =>
    attempt(async () =>
      sessions().authorize(callContext(), (ctx) => docgen().office.current(ctx)),
    ),
);

/**
 * Everything the office holds in the document service, as a file.
 *
 * It answers with bytes rather than a record: the export is meant to be kept,
 * and handing it over as a download is what makes portability something a
 * person can actually act on. A person's own data, and their account, are
 * exported and erased on the Imobiliary platform.
 */
export const exportOffice = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<FileContent>> =>
    attempt(async () => {
      // POST and origin-checked like a mutation: it returns everything the
      // office holds, and a GET is reachable by any top-level navigation from
      // another site.
      assertSameOrigin();
      return sessions().authorize(callContext(), (ctx) =>
        docgen().office.exportOffice(ctx),
      );
    }),
);

/** Where the platform's own screens live, for the links this platform shows. */
export interface PlatformLinks {
  readonly signUp: string;
  readonly passwordReset: string;
  readonly security: string;
  readonly account: string;
}

/**
 * The platform's addresses, read on the server.
 *
 * The screens need them, and the deployment configures them, so they are
 * answered rather than written into the pages: a link to localhost must not
 * ship in production, and a link to production must not appear here.
 */
export const platformLinks = createServerFn({ method: "GET" }).handler(
  async (): Promise<PlatformLinks> => {
    const base = getConfig().platformUrl;
    return {
      signUp: `${base}/criar-conta`,
      passwordReset: `${base}/esqueci-senha`,
      security: `${base}/ajustes?aba=seguranca`,
      account: `${base}/ajustes?aba=dados`,
    };
  },
);

function currentUserOf(session: {
  user: User;
  organization: Organization;
  role: Role;
}): CurrentUser {
  return {
    user: session.user,
    organization: session.organization,
    role: session.role,
  };
}
