/**
 * The account holder's rights: a copy of the data, and erasure.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { fieldError, ValidationError } from "../domain/errors.ts";
import { createCookieSessionStore } from "../infrastructure/session/cookie-session-store.ts";
import { api, assertSameOrigin, callContext, sessions } from "./runtime.ts";

export interface ExportedFile {
  readonly filename: string;
  readonly content: string;
}

/**
 * Everything held about the account, as a file to save.
 *
 * A POST with the origin check, like a mutation: it returns the whole account,
 * and a GET could be reached by a top-level navigation from another site.
 */
export const exportAccount = createServerFn({ method: "POST" }).handler(
  async (): Promise<Result<ExportedFile>> =>
    attempt(async () => {
      assertSameOrigin();
      const text = await sessions().authorize(callContext(), (ctx) => api().privacy.exportData(ctx));
      // Re-indented so the file reads in a text editor. Parsing also proves it
      // is JSON before anyone is handed it as such.
      const content = JSON.stringify(JSON.parse(text), null, 2);
      const day = new Date().toISOString().slice(0, 10);
      return { filename: `imobiliary-meus-dados-${day}.json`, content };
    }),
);

/**
 * Erases the account.
 *
 * The cookie is cleared directly afterwards rather than through signOut, which
 * would first ask the API to end a session of an account that no longer exists
 * and report that failure as if the deletion had gone wrong.
 */
export const deleteAccount = createServerFn({ method: "POST" })
  .validator((password: string) => password)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      if (data === "") {
        throw fieldError("password", "Informe sua senha.");
      }

      try {
        await sessions().authorize(callContext(), (ctx) => api().privacy.deleteAccount(ctx, data));
      } catch (error) {
        // The API names the office in English. What the person needs is what
        // to do about it, in the words of this screen.
        if (error instanceof ValidationError && error.messageFor("organizations") !== undefined) {
          throw fieldError(
            "organizations",
            "Você é o único administrador de um escritório que tem outros membros. Em Escritório, torne outra pessoa administradora antes de excluir a conta.",
          );
        }
        throw error;
      }

      await createCookieSessionStore().clear();
      return null;
    }),
  );
