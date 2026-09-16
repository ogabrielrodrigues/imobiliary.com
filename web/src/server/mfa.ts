/**
 * The second factor, from the settings screen.
 *
 * The recovery codes cross this line exactly twice: when the factor is turned
 * on, and when a new list is asked for. They are never stored here and never
 * fetched again, because the API keeps only their digests.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { fieldError } from "../domain/errors.ts";
import { validateSecondFactorCode } from "../domain/user.ts";
import { createCookieSessionStore } from "../infrastructure/session/cookie-session-store.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

export interface Enrollment {
  readonly secret: string;
  readonly uri: string;
}

/** Starts an enrolment: the secret, and the otpauth address behind the QR. */
export const startEnrollment = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<Enrollment>> =>
    attempt(async () => {
      assertSameOrigin();
      const manager = sessions();
      return manager.authorize(callContext(), (ctx) => api().secondFactor.start(ctx));
    }),
);

/**
 * Proves a code and turns the second factor on.
 *
 * The session in the cookie says whether an administrator still owes an
 * enrolment, so it is refreshed here: without that the person would keep being
 * sent to this screen until their access token expired.
 */
export const confirmEnrollment = createServerFn({ method: "POST" })
  .validator((code: string) => code)
  .handler(async ({ data }): Promise<Result<readonly string[]>> =>
    attempt(async () => {
      assertSameOrigin();

      const invalid = validateSecondFactorCode(data);
      if (invalid) throw invalid;

      const manager = sessions();
      const codes = await manager.authorize(callContext(), (ctx) =>
        api().secondFactor.confirm(ctx, data.trim()),
      );
      await refreshStoredSession();
      return codes;
    }),
  );

/** Turns the second factor off, which takes the password again. */
export const disableSecondFactor = createServerFn({ method: "POST" })
  .validator((password: string) => password)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      if (data === "") throw fieldError("password", "Informe sua senha.");

      const manager = sessions();
      await manager.authorize(callContext(), (ctx) => api().secondFactor.disable(ctx, data));
      await refreshStoredSession();
      return null;
    }),
  );

/** Hands out a new list of recovery codes and invalidates the old one. */
export const regenerateRecoveryCodes = createServerFn({ method: "POST" })
  .validator((password: string) => password)
  .handler(async ({ data }): Promise<Result<readonly string[]>> =>
    attempt(async () => {
      assertSameOrigin();
      if (data === "") throw fieldError("password", "Informe sua senha.");

      const manager = sessions();
      return manager.authorize(callContext(), (ctx) =>
        api().secondFactor.regenerateRecoveryCodes(ctx, data),
      );
    }),
  );

/**
 * Rotates the session so the cookie reflects a state the API has changed.
 *
 * Refreshing is how a client asks the API "what is true now": the answer
 * carries the enrolment flag and the account's own TOTP state, both of which
 * just moved.
 */
async function refreshStoredSession(): Promise<void> {
  const store = createCookieSessionStore();
  const current = await store.read();
  if (current === null) return;

  const rotated = await api().identity.refresh(callContext(), current.refreshToken);
  await store.write(rotated);
}
