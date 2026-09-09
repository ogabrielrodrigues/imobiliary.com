/**
 * Generated-document operations, exposed as server functions.
 */

import { createServerFn } from "@tanstack/react-start";

import type { FileContent } from "../application/ports.ts";
import { attempt, type Result } from "../application/result.ts";
import {
  validateDocumentData,
  type GeneratedDocument,
  type GenerateInput,
} from "../domain/document.ts";
import { assertSameOrigin, callContext, docgen, sessions } from "./runtime.ts";

export const listDocuments = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<GeneratedDocument[]>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        docgen().documents.list(ctx),
      ),
    ),
);

/**
 * Renders a document.
 *
 * The values are checked against the schema the caller passes in — the one it
 * just read from the template — so a missing or misspelled field is reported
 * without a round trip. The API validates independently and has the last word.
 */
export const generateDocument = createServerFn({ method: "POST" })
  .inputValidator(
    (input: GenerateInput & { placeholders: readonly string[] }) => input,
  )
  .handler(
    async ({ data }): Promise<Result<GeneratedDocument>> =>
      attempt(async () => {
        assertSameOrigin();

        const { placeholders, ...request } = data;

        const invalid = validateDocumentData(placeholders, request.data);
        if (invalid) throw invalid;

        return sessions().authorize(callContext(), (ctx) =>
          docgen().documents.generate(ctx, request),
        );
      }),
  );

/**
 * Fetches a generated document's bytes so the browser can save them.
 *
 * The bytes travel as a `Uint8Array`, which Start's serialiser sends in its
 * binary frame — no base64, and none of the third it would add. The browser
 * turns them into a Blob and saves it; the API is never reachable from the
 * page, so a plain link to it was never an option.
 */
export const downloadDocument = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(
    async ({ data }): Promise<Result<FileContent>> =>
      attempt(() =>
        sessions().authorize(callContext(), (ctx) =>
          docgen().documents.download(ctx, data),
        ),
      ),
  );
