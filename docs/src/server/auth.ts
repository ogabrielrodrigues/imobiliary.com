/**
 * Authentication, exposed to the browser as server functions.
 *
 * These are the only way the interface reaches the API. Tokens never cross this
 * line: what goes back to the page is an account, never a credential.
 *
 * Expected failures come back as a `Result` rather than as a thrown error — see
 * `application/result.ts` for why.
 */

import { createServerFn } from "@tanstack/react-start";

import type { FileContent } from "../application/ports.ts";
import { attempt, type Result } from "../application/result.ts";
import { fieldError } from "../domain/errors.ts";
import type { User } from "../domain/user.ts";
import {
  normalizeEmail,
  validateLogin,
  validateNewPassword,
  validatePasswordChange,
  validateRegistration,
  type LoginInput,
  type PasswordChangeInput,
  type RegistrationInput,
} from "../domain/user.ts";
import { createCookieSessionStore } from "../infrastructure/session/cookie-session-store.ts";
import { assertSameOrigin, callContext, docgen, sessions } from "./runtime.ts";

/** What a person types to confirm they mean it. */
export const ACCOUNT_DELETION_CONFIRMATION = "EXCLUIR";

/**
 * Creates an account.
 *
 * It does not sign the user in — the API deliberately separates the two, and
 * the interface sends them to the sign-in screen next.
 *
 * The answer is the same whether or not the address was already taken: the API
 * returns nothing that could tell the two apart, and neither does this.
 */
export const register = createServerFn({ method: "POST" })
  .validator((input: RegistrationInput) => input)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();

      // Validating here spares a round trip. The API validates independently
      // and remains the authority; this never relaxes a rule.
      const invalid = validateRegistration(data);
      if (invalid) throw invalid;

      await docgen().auth.register(callContext(), {
        ...data,
        email: data.email.trim(),
        name: data.name.trim(),
      });
      return null;
    }),
  );

/** Exchanges credentials for a session and seals it into the cookie. */
export const login = createServerFn({ method: "POST" })
  .validator((input: LoginInput) => input)
  .handler(async ({ data }): Promise<Result<User>> =>
    attempt(async () => {
      assertSameOrigin();

      const invalid = validateLogin(data);
      if (invalid) throw invalid;

      const session = await docgen().auth.login(callContext(), {
        ...data,
        email: data.email.trim(),
      });
      await sessions().signIn(session);

      return session.user;
    }),
  );

/** Ends the session here and at the API. */
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
 * Reading the cookie is enough: the account it carries was put there by the API
 * at sign-in, and asking the API again on every page load would spend a request
 * to learn something already known.
 *
 * This one returns a bare value rather than a Result — a visitor who is not
 * signed in is an ordinary answer, not a failure.
 */
export const currentUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<User | null> => {
    const session = await sessions().current();
    return session?.user ?? null;
  },
);

/**
 * Everything held about the account, as a file.
 *
 * It answers with bytes rather than a record:
 * the export is meant to be kept, and handing it over as a download is what
 * makes portability something a person can actually act on.
 */
export const exportAccount = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<FileContent>> =>
    attempt(async () => {
      // POST and origin-checked like a mutation: it returns everything held
      // about the account, and a GET is reachable by any top-level navigation
      // from another site.
      assertSameOrigin();
      return sessions().authorize(callContext(), (ctx) =>
        docgen().auth.exportAccount(ctx),
      );
    }),
);

/**
 * Erases the account and everything belonging to it.
 *
 * The session cookie is cleared afterwards whatever happens at the API: once
 * the account is gone the cookie names nobody, and leaving it in place would
 * send the browser back to a dashboard that can only fail.
 */
export const deleteAccount = createServerFn({ method: "POST" })
  .validator((confirmation: string) => confirmation)
  .handler(
    async ({ data }): Promise<Result<null>> =>
      attempt(async () => {
        assertSameOrigin();

        // Typed by hand on the screen. It is not a security control — the
        // session already authorised this — but a deliberate pause in front of
        // the one action here that cannot be undone.
        if (data !== ACCOUNT_DELETION_CONFIRMATION) {
          throw fieldError(
            "confirmation",
            `Digite ${ACCOUNT_DELETION_CONFIRMATION} para confirmar.`,
          );
        }

        await sessions().authorize(callContext(), (ctx) =>
          docgen().auth.deleteAccount(ctx),
        );
		// The cookie is cleared directly rather than through signOut, which would
		// first ask the API to end a session belonging to an account that no
		// longer exists — a failure that would be reported as if the deletion had
		// gone wrong when it had just succeeded.
		await createCookieSessionStore().clear();
        return null;
      }),
  );

/**
 * Replaces the password of the signed-in account.
 *
 * The API answers with a whole new session, and it has to: changing a password
 * ends every session of the account, this one included, so without the
 * replacement the browser would be signed out by its own successful request.
 * Writing it to the cookie is what makes the change feel like nothing happened
 * here while ending it everywhere else.
 */
export const changePassword = createServerFn({ method: "POST" })
  .validator((input: PasswordChangeInput) => input)
  .handler(
    async ({ data }): Promise<Result<null>> =>
      attempt(async () => {
        assertSameOrigin();

        const invalid = validatePasswordChange(data);
        if (invalid) throw invalid;

        const session = await sessions().authorize(callContext(), (ctx) =>
          docgen().auth.changePassword(ctx, data),
        );
        await sessions().signIn(session);
        return null;
      }),
  );

/**
 * Asks for a reset link.
 *
 * Answers the same whether or not the address belongs to anyone — the API is
 * built that way, and repeating the guarantee here means the interface cannot
 * accidentally undo it by reporting a failure the API deliberately swallowed.
 */
export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator((email: string) => email)
  .handler(
    async ({ data }): Promise<Result<null>> =>
      attempt(async () => {
        assertSameOrigin();

        if (normalizeEmail(data) === "") {
          throw fieldError("email", "Informe seu e-mail.");
        }

        await docgen().auth.requestPasswordReset(callContext(), data);
        return null;
      }),
  );

/**
 * Sets a new password from a reset link.
 *
 * No session is opened afterwards. A reset assumes the account may already be
 * in someone else's hands, so it leaves nobody signed in — including whoever
 * followed the link — and the screen sends them to sign in with what they just
 * chose.
 */
export const resetPassword = createServerFn({ method: "POST" })
  .validator((input: { token: string; password: string }) => input)
  .handler(
    async ({ data }): Promise<Result<null>> =>
      attempt(async () => {
        assertSameOrigin();

        if (data.token === "") {
          throw fieldError("password", "Link inválido ou incompleto.");
        }
        const invalid = validateNewPassword(data.password);
        if (invalid) throw invalid;

        await docgen().auth.resetPassword(callContext(), data.token, data.password);
        return null;
      }),
  );
