/**
 * Generated-document operations, exposed as server functions.
 */

import { createServerFn } from "@tanstack/react-start";

import type { FileContent } from "../application/ports.ts";
import { attempt, type Result } from "../application/result.ts";
import type { DocumentListItem, DocumentPage } from "../application/views.ts";
import {
  validateDocumentData,
  type GeneratedDocument,
  type GenerateInput,
} from "../domain/document.ts";
import { assertSameOrigin, callContext, docgen, sessions } from "./runtime.ts";

/**
 * How many templates are fetched to resolve names. The API caps a page at 100,
 * and a document whose template falls outside that page simply shows no name —
 * which the interface states plainly rather than papering over.
 */
const TEMPLATE_NAME_LOOKUP_LIMIT = 100;

/** Documents per page of the list. */
export const DOCUMENTS_PAGE_SIZE = 20;

/** A page far past any real account; it only bounds the offset sent on. */
const MAX_PAGE = 10_000;

/**
 * Lists one page of generated documents, each with the name of the template
 * behind it.
 *
 * The API returns only the template's identifier, and an identifier tells a
 * person nothing. The join happens here, in one extra call, rather than as one
 * call per row from the browser.
 *
 * One row more than the page is requested: the API reports no total, and that
 * extra row is how the list knows whether there is a next page.
 */
export const listDocuments = createServerFn({ method: "GET" })
  .inputValidator((input: { page?: number }): { page: number } => ({
    page:
      Number.isInteger(input.page) && (input.page ?? 0) >= 0
        ? Math.min(input.page ?? 0, MAX_PAGE)
        : 0,
  }))
  .handler(
    async ({ data }): Promise<Result<DocumentPage>> =>
      attempt(() =>
        sessions().authorize(callContext(), async (ctx) => {
          const [documents, templates] = await Promise.all([
            docgen().documents.list(ctx, {
              limit: DOCUMENTS_PAGE_SIZE + 1,
              offset: data.page * DOCUMENTS_PAGE_SIZE,
            }),
            docgen().templates.list(ctx, { limit: TEMPLATE_NAME_LOOKUP_LIMIT }),
          ]);

          const names = new Map(templates.map((t) => [t.id, t.name]));

          return {
            items: documents.slice(0, DOCUMENTS_PAGE_SIZE).map(
              (document): DocumentListItem => ({
                document,
                templateName: names.get(document.templateId) ?? null,
              }),
            ),
            page: data.page,
            pageSize: DOCUMENTS_PAGE_SIZE,
            hasNext: documents.length > DOCUMENTS_PAGE_SIZE,
          };
        }),
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
