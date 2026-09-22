/**
 * Generating a lease's documents, and listing the ones it already has.
 *
 * Two services are involved and only this layer sees both: this API answers
 * what a contract fills a template with, and the document service holds the
 * templates and renders the file. The values are read here and sent there, so
 * the document service never learns what a lease is.
 *
 * The preview is drawn from the template's own archive with the shared reader,
 * so the office reviews what it is about to sign rather than a list of fields.
 */

import { createServerFn } from "@tanstack/react-start";

import { parseDocx } from "@imobiliary/docx/parse";
import type { Block } from "@imobiliary/docx/blocks";

import { attempt, type Result } from "../application/result.ts";
import type { FileContent } from "../application/ports.ts";
import { ValidationError } from "../domain/errors.ts";
import {
  cleanDocumentName,
  subjectReference,
  type DocumentField,
  type DocumentSubject,
  type GeneratedDocument,
  type Template,
} from "../domain/document.ts";
import {
  api,
  assertSameOrigin,
  callContext,
  documents,
  sessions,
} from "./runtime.ts";

/** The office's templates, for the picker. */
export const listTemplates = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<Template[]>> =>
    attempt(() =>
      sessions().authorizeDocuments(callContext(), (ctx) =>
        documents().listTemplates(ctx),
      ),
    ),
);

/** A template, its placeholders, and how a lease answers them. */
export interface DocumentDraft {
  readonly template: Template;
  readonly placeholders: readonly string[];
  readonly fields: readonly DocumentField[];
  /**
   * The template read as a document, or null when it cannot be read.
   *
   * A preview that fails is not an error: the document is still rendered by
   * the service from the original archive, so the screen falls back to the
   * plain list of fields and says so.
   */
  readonly blocks: readonly Block[] | null;
}

/** Everything the review screen needs: the template, its text, and the values. */
export const getDocumentDraft = createServerFn({ method: "GET" })
  .validator((input: { subject: DocumentSubject; templateId: string }) => input)
  .handler(async ({ data }): Promise<Result<DocumentDraft>> =>
    attempt(async () => {
      const manager = sessions();
      const ctx = callContext();

      const [fields, template] = await Promise.all([
        // A contract answers its lease fields; a payout, its statement's.
        manager.authorize(ctx, (c) =>
          data.subject.kind === "payout"
            ? api().payouts.documentFields(c, data.subject.id)
            : api().contracts.documentFields(c, data.subject.id),
        ),
        manager.authorizeDocuments(ctx, (c) =>
          documents().getTemplate(c, data.templateId),
        ),
      ]);

      const version = template.version?.version ?? template.latestVersion;
      const placeholders = template.version?.placeholders ?? [];

      let blocks: readonly Block[] | null = null;
      try {
        const archive = await manager.authorizeDocuments(ctx, (c) =>
          documents().downloadTemplateVersion(c, template.id, version),
        );
        blocks = parseDocx(archive);
      } catch {
        // Left null on purpose: the screen shows the fields instead, and the
        // document itself is rendered by the service from this same archive.
        blocks = null;
      }

      return { template, placeholders, fields, blocks };
    }),
  );

export interface GenerateDocumentInput {
  readonly subject: DocumentSubject;
  readonly templateId: string;
  readonly filename: string;
  readonly values: Record<string, string>;
}

/** Renders the document and files it under its record. */
export const generateDocument = createServerFn({ method: "POST" })
  .validator((input: GenerateDocumentInput) => input)
  .handler(async ({ data }): Promise<Result<GeneratedDocument>> =>
    attempt(async () => {
      assertSameOrigin();

      const filename = cleanDocumentName(data.filename);
      if (filename === "") {
        throw new ValidationError([
          { field: "filename", message: "Dê um nome ao documento." },
        ]);
      }

      const manager = sessions();
      const ctx = callContext();

      const template = await manager.authorizeDocuments(ctx, (c) =>
        documents().getTemplate(c, data.templateId),
      );
      const placeholders = template.version?.placeholders ?? [];

      // The service refuses a body that misses a placeholder or carries one it
      // does not know, so the values are cut to the template's own list: a
      // contract answers more fields than any one template asks for.
      const values: Record<string, string> = {};
      const missing: string[] = [];
      for (const name of placeholders) {
        const value = (data.values[name] ?? "").trim();
        if (value === "") missing.push(name);
        values[name] = value;
      }
      if (missing.length > 0) {
        throw new ValidationError(
          missing.map((name) => ({
            field: `data.${name}`,
            message: "Preencha este campo antes de gerar.",
          })),
        );
      }

      return manager.authorizeDocuments(ctx, (c) =>
        documents().generate(c, {
          templateId: template.id,
          ...(template.version === undefined ? {} : { version: template.version.version }),
          filename,
          data: values,
          reference: subjectReference(data.subject),
        }),
      );
    }),
  );

/** The documents already generated for one contract, newest first. */
export const listContractDocuments = createServerFn({ method: "GET" })
  .validator((contractId: string) => contractId)
  .handler(async ({ data }): Promise<Result<GeneratedDocument[]>> =>
    attempt(() =>
      sessions().authorizeDocuments(callContext(), (ctx) =>
        documents().listByReference(ctx, subjectReference({ kind: "contract", id: data })),
      ),
    ),
  );

/** The file itself, for download or for reading inside the platform. */
export const downloadDocument = createServerFn({ method: "POST" })
  .validator((documentId: string) => documentId)
  .handler(async ({ data }): Promise<Result<FileContent>> =>
    attempt(async () => {
      // POST and origin-checked: it hands over a document in full, and a GET
      // is reachable by any top-level navigation from another site.
      assertSameOrigin();
      return sessions().authorizeDocuments(callContext(), (ctx) =>
        documents().download(ctx, data),
      );
    }),
  );

/** The document as blocks, to read it inside the contract's page. */
export const readDocument = createServerFn({ method: "POST" })
  .validator((documentId: string) => documentId)
  .handler(async ({ data }): Promise<Result<readonly Block[]>> =>
    attempt(async () => {
      assertSameOrigin();
      const file = await sessions().authorizeDocuments(callContext(), (ctx) =>
        documents().download(ctx, data),
      );
      return parseDocx(file.bytes);
    }),
  );

/** Erases one document, its values and its file. */
export const deleteDocument = createServerFn({ method: "POST" })
  .validator((documentId: string) => documentId)
  .handler(async ({ data }): Promise<Result<null>> =>
    attempt(async () => {
      assertSameOrigin();
      await sessions().authorizeDocuments(callContext(), (ctx) =>
        documents().remove(ctx, data),
      );
      return null;
    }),
  );

/** The documents already generated for one payout, newest first. */
export const listPayoutDocuments = createServerFn({ method: "GET" })
  .validator((payoutId: string) => payoutId)
  .handler(async ({ data }): Promise<Result<GeneratedDocument[]>> =>
    attempt(() =>
      sessions().authorizeDocuments(callContext(), (ctx) =>
        documents().listByReference(ctx, subjectReference({ kind: "payout", id: data })),
      ),
    ),
  );
