/**
 * The generation history and batches, exposed as server functions.
 */

import { createServerFn } from "@tanstack/react-start";

import { collectPages } from "../application/paging.ts";
import type { FileContent } from "../application/ports.ts";
import { attempt, type Result } from "../application/result.ts";
import type {
  DocumentListItem,
  DocumentPage,
  HistoryItem,
  HistoryPage,
} from "../application/views.ts";
import { MAX_BATCH_NAME_LENGTH, type Batch } from "../domain/batch.ts";
import { fieldError, NotFoundError } from "../domain/errors.ts";
import { assertSameOrigin, callContext, docgen, sessions } from "./runtime.ts";

/** Entries per page of the history, and documents per page inside a batch. */
export const HISTORY_PAGE_SIZE = 20;

/** A page far past any real account; it only bounds the offset sent on. */
const MAX_PAGE = 10_000;

const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pageOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, MAX_PAGE)
    : 0;
}

/** An identifier, or undefined for anything that is not one. */
function identifierOf(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

/**
 * One page of the history, with the name of the template behind each entry and
 * the active templates for the filter.
 *
 * One entry more than the page is asked for, to learn whether a next page
 * exists: the API reports no total. A filter that is not an identifier is
 * dropped rather than refused, so a mangled address still shows the history.
 */
export const getHistory = createServerFn({ method: "GET" })
  .validator((input: { page?: number; templateId?: string }) => ({
    page: pageOf(input.page),
    templateId: identifierOf(input.templateId),
  }))
  .handler(
    async ({ data }): Promise<Result<HistoryPage>> =>
      attempt(() =>
        sessions().authorize(callContext(), async (ctx) => {
          const [entries, templates] = await Promise.all([
            docgen().batches.history(
              ctx,
              { limit: HISTORY_PAGE_SIZE + 1, offset: data.page * HISTORY_PAGE_SIZE },
              { templateId: data.templateId },
            ),
            collectPages((page) => docgen().templates.list(ctx, page)),
          ]);

          const names = new Map(templates.items.map((t) => [t.id, t.name]));
          const nameOf = (id: string) => names.get(id) ?? null;

          return {
            items: entries.slice(0, HISTORY_PAGE_SIZE).map(
              (entry): HistoryItem =>
                entry.kind === "batch"
                  ? { kind: "batch", batch: entry.batch, templateName: nameOf(entry.batch.templateId) }
                  : {
                      kind: "document",
                      item: { document: entry.document, templateName: nameOf(entry.document.templateId) },
                    },
            ),
            page: data.page,
            pageSize: HISTORY_PAGE_SIZE,
            hasNext: entries.length > HISTORY_PAGE_SIZE,
            templates: templates.items
              .map((t) => ({ id: t.id, name: t.name }))
              .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
          };
        }),
      ),
  );

/**
 * One page of the documents inside a batch, newest first like the rest of the
 * history: the API lists documents in that order only. The batch's ZIP is the
 * one place they come in generation order.
 */
export const listBatchDocuments = createServerFn({ method: "GET" })
  .validator((input: { batchId: string; page?: number }) => ({
    batchId: identifierOf(input.batchId),
    page: pageOf(input.page),
  }))
  .handler(
    async ({ data }): Promise<Result<DocumentPage>> =>
      attempt(() =>
        sessions().authorize(callContext(), async (ctx) => {
          if (data.batchId === undefined) throw new NotFoundError();

          const [documents, templates] = await Promise.all([
            docgen().documents.list(
              ctx,
              { limit: HISTORY_PAGE_SIZE + 1, offset: data.page * HISTORY_PAGE_SIZE },
              { batchId: data.batchId },
            ),
            collectPages((page) => docgen().templates.list(ctx, page)),
          ]);

          const names = new Map(templates.items.map((t) => [t.id, t.name]));

          return {
            items: documents.slice(0, HISTORY_PAGE_SIZE).map(
              (document): DocumentListItem => ({
                document,
                templateName: names.get(document.templateId) ?? null,
              }),
            ),
            page: data.page,
            pageSize: HISTORY_PAGE_SIZE,
            hasNext: documents.length > HISTORY_PAGE_SIZE,
          };
        }),
      ),
  );

/**
 * A batch as a ZIP of its documents. The bytes cross in Start's binary frame,
 * as a single document's do.
 */
export const downloadBatch = createServerFn({ method: "GET" })
  .validator((id: string) => identifierOf(id))
  .handler(
    async ({ data }): Promise<Result<FileContent>> =>
      attempt(() =>
        sessions().authorize(callContext(), (ctx) => {
          if (data === undefined) throw new NotFoundError();
          return docgen().batches.download(ctx, data);
        }),
      ),
  );

/**
 * Creates an empty batch for one template version. The documents join it one
 * generation at a time, through generateDocument with `batchId`.
 */
export const createBatch = createServerFn({ method: "POST" })
  .validator((input: { templateId: string; version?: number; name: string }) => input)
  .handler(
    async ({ data }): Promise<Result<Batch>> =>
      attempt(async () => {
        assertSameOrigin();

        const name = data.name.trim();
        if (name === "") throw fieldError("name", "Dê um nome ao lote.");
        if ([...name].length > MAX_BATCH_NAME_LENGTH) {
          throw fieldError("name", `O nome deve ter no máximo ${MAX_BATCH_NAME_LENGTH} caracteres.`);
        }
        const templateId = identifierOf(data.templateId);
        if (templateId === undefined) throw new NotFoundError();

        return sessions().authorize(callContext(), (ctx) =>
          docgen().batches.create(ctx, {
            templateId,
            name,
            ...(data.version === undefined ? {} : { version: data.version }),
          }),
        );
      }),
  );

/** Erases a batch, its documents and the files nothing else uses. */
export const deleteBatch = createServerFn({ method: "POST" })
  .validator((id: string) => identifierOf(id))
  .handler(
    async ({ data }): Promise<Result<null>> =>
      attempt(async () => {
        assertSameOrigin();
        if (data === undefined) throw new NotFoundError();

        await sessions().authorize(callContext(), (ctx) => docgen().batches.remove(ctx, data));
        return null;
      }),
  );
