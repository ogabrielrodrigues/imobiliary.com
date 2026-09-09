/**
 * Authentication, exposed to the browser as server functions.
 *
 * These are the only way the interface reaches the API. Tokens never cross this
 * line: what goes back to the page is an account, never a credential.
 */

import { createServerFn } from "@tanstack/react-start";

import type { User } from "../domain/user.ts";
import {
  validateLogin,
  validateRegistration,
  type LoginInput,
  type RegistrationInput,
} from "../domain/user.ts";
import { assertSameOrigin, callContext, docgen, sessions } from "./runtime.ts";

/**
 * Creates an account.
 *
 * It does not sign the user in — the API deliberately separates the two, and
 * the interface sends them to the sign-in screen next.
 */
export const register = createServerFn({ method: "POST" })
  .inputValidator((input: RegistrationInput) => input)
  .handler(async ({ data }): Promise<User> => {
    assertSameOrigin();

    // Validating here spares a round trip. The API validates independently and
    // remains the authority; this never relaxes a rule.
    const invalid = validateRegistration(data);
    if (invalid) throw invalid;

    return docgen().auth.register(callContext(), data);
  });

/** Exchanges credentials for a session and seals it into the cookie. */
export const login = createServerFn({ method: "POST" })
  .inputValidator((input: LoginInput) => input)
  .handler(async ({ data }): Promise<User> => {
    assertSameOrigin();

    const invalid = validateLogin(data);
    if (invalid) throw invalid;

    const session = await docgen().auth.login(callContext(), data);
    await sessions().signIn(session);

    return session.user;
  });

/** Ends the session here and at the API. */
export const logout = createServerFn({ method: "POST" }).handler(
  async (): Promise<void> => {
    assertSameOrigin();
    await sessions().signOut(callContext());
  },
);

/**
 * The signed-in account, or null.
 *
 * Reading the cookie is enough — the account it carries was put there by the
 * API at sign-in, and asking the API again on every page load would spend a
 * request to learn something already known.
 */
export const currentUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<User | null> => {
    const session = await sessions().current();
    return session?.user ?? null;
  },
);
