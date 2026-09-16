/**
 * Passwords: changing one, and recovering a forgotten one.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { fieldError } from "../domain/errors.ts";
import { validateEmail, validatePassword } from "../domain/user.ts";
import { createCookieSessionStore } from "../infrastructure/session/cookie-session-store.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

export interface ChangePasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
}

/**
 * Changes the password, which ends every session of the account.
 *
 * The cookie is cleared here on purpose: the API has just invalidated the
 * tokens inside it, so keeping it would leave the browser holding a session
 * that fails on its next call. The screen sends the person to sign in again,
 * which is what actually happened.
 */
export const changePassword = createServerFn({ method: "POST" })
  .validator((input: ChangePasswordInput) => input)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();

      if (data.currentPassword === "") {
        throw fieldError("current_password", "Informe sua senha atual.");
      }
      const invalid = validatePassword(data.newPassword, "new_password");
      if (invalid) throw fieldError(invalid.field, invalid.message);

      const manager = sessions();
      await manager.authorize(callContext(), (ctx) =>
        api().passwords.change(ctx, {
          currentPassword: data.currentPassword,
          newPassword: data.newPassword,
        }),
      );
      await createCookieSessionStore().clear();
      return null;
    }),
  );

/**
 * Asks for a reset link.
 *
 * It answers the same for an address with an account and one without, because
 * the API does: anything else would turn this form into a directory of who has
 * an account here.
 */
export const forgotPassword = createServerFn({ method: "POST" })
  .validator((email: string) => email)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();

      const email = data.trim();
      const invalid = validateEmail(email);
      if (invalid) throw fieldError(invalid.field, invalid.message);

      await api().passwords.forget(callContext(), email);
      return null;
    }),
  );

export interface ResetPasswordInput {
  readonly token: string;
  readonly password: string;
}

/** Sets a new password from a link, for someone who cannot sign in. */
export const resetPassword = createServerFn({ method: "POST" })
  .validator((input: ResetPasswordInput) => input)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();

      if (data.token.trim() === "") {
        throw fieldError("request", "O link está incompleto. Peça um novo.");
      }
      const invalid = validatePassword(data.password);
      if (invalid) throw fieldError(invalid.field, invalid.message);

      await api().passwords.reset(callContext(), {
        token: data.token,
        password: data.password,
      });
      return null;
    }),
  );
