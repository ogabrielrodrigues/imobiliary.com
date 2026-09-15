/**
 * Template operations, exposed to the browser as server functions.
 *
 * Every call goes through `sessions().authorize`, which is what guarantees a
 * spent access token is refreshed once, under single-flight, before the API
 * ever sees it.
 */

import { createServerFn } from "@tanstack/react-start";

import { collectPages, LISTING_CAP } from "../application/paging.ts";
import { attempt, type Result } from "../application/result.ts";
import { fieldError, NotFoundError, ValidationError, type FieldError } from "../domain/errors.ts";
import {
  DOCX_MEDIA_TYPE,
  validateTemplateDetails,
  validateTemplateFile,
  validateTemplateUpload,
  type Template,
  type TemplateVersion,
} from "../domain/template.ts";
import type { Block } from "../domain/block.ts";
import {
  blockOf,
  describesDocument,
  MAX_BLOCKS,
  normalizeBlocks,
  parseBlockSource,
  validateBlocks,
} from "../domain/block-source.ts";
import { cleanDocumentName } from "../domain/document-name.ts";
import { buildDocx, SOURCE_PART } from "../infrastructure/docx/build.ts";
import { parseDocx } from "../infrastructure/docx/parse.ts";
import { readZipEntry } from "../infrastructure/docx/zip.ts";
import { assertSameOrigin, callContext, docgen, sessions } from "./runtime.ts";

/**
 * The most templates the list reads. The search on that screen runs over what
 * was fetched, since the API offers none, so the list reads every page up to
 * this cap; the screen says when it may have been reached.
 */
export const TEMPLATE_LIST_CAP = LISTING_CAP;

export const listTemplates = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<Template[]>> =>
    attempt(() =>
      sessions().authorize(callContext(), async (ctx) => {
        const { items } = await collectPages((page) => docgen().templates.list(ctx, page));
        return [...items];
      }),
    ),
);

/**
 * Uploads a .docx and creates a template from it.
 *
 * The payload stays FormData all the way through: turning the file into base64
 * to cross the boundary would inflate it by a third and buy nothing, since the
 * API wants multipart anyway.
 *
 * Only the shape is checked here. Whether the archive is a real .docx, holds
 * `word/document.xml`, and uses an accepted placeholder grammar is the API's
 * job — it inspects the archive properly, and its answer is the one that counts.
 */
export const createTemplate = createServerFn({ method: "POST" })
  .validator((form: FormData) => form)
  .handler(
    async ({ data }): Promise<Result<Template>> =>
      attempt(async () => {
        assertSameOrigin();

        const file = data.get("file");
        if (!(file instanceof File)) {
          throw fieldError("file", "Escolha um arquivo .docx.");
        }

        const input = {
          name: String(data.get("name") ?? "").trim(),
          description: String(data.get("description") ?? "").trim(),
          file,
        };

        const invalid = validateTemplateUpload(input);
        if (invalid) throw invalid;

        return sessions().authorize(callContext(), (ctx) =>
          docgen().templates.create(ctx, input),
        );
      }),
  );

/**
 * A block tree sent by the browser, checked and in its normal form, with the
 * problems found under `content`. The browser is not trusted to have run the
 * same checks: this is what decides what reaches the writer.
 */
function checkedContent(raw: unknown): { tree: Block[]; problems: FieldError[] } {
  const unreadable = {
    tree: [],
    problems: [{ field: "content", message: "Não foi possível ler o conteúdo do modelo." }],
  };
  if (!Array.isArray(raw) || raw.length > MAX_BLOCKS) return unreadable;

  const blocks: Block[] = [];
  for (const item of raw) {
    const block = blockOf(item);
    if (block === null) return unreadable;
    blocks.push(block);
  }
  const tree = normalizeBlocks(blocks);
  return { tree, problems: validateBlocks(tree) };
}

/** The .docx for a tree, named after the template. */
function templateFile(tree: readonly Block[], name: string): File {
  const bytes = buildDocx(tree, { title: name });
  return new File([new Uint8Array(bytes)], `${cleanDocumentName(name) || "modelo"}.docx`, {
    type: DOCX_MEDIA_TYPE,
  });
}

/**
 * Creates a template from a document written in the block editor.
 *
 * The .docx is built here, on the server, where the writer and `node:zlib`
 * live; from then on it is an upload like any other, and the API inspects it
 * the same way. Name, description and content are checked together, so every
 * problem shows at once.
 */
export const createTemplateFromBlocks = createServerFn({ method: "POST" })
  .validator((input: { name: string; description: string; blocks: unknown }) => input)
  .handler(
    async ({ data }): Promise<Result<Template>> =>
      attempt(async () => {
        assertSameOrigin();

        const name = String(data.name ?? "").trim();
        const description = String(data.description ?? "").trim();
        const { tree, problems } = checkedContent(data.blocks);
        const fields = [...validateTemplateDetails({ name, description }), ...problems];
        if (fields.length > 0) throw new ValidationError(fields);

        const file = templateFile(tree, name);
        const invalid = validateTemplateUpload({ name, description, file });
        if (invalid) throw invalid;

        return sessions().authorize(callContext(), (ctx) =>
          docgen().templates.create(ctx, { name, description, file }),
        );
      }),
  );

/**
 * Publishes a new version of a template from the block editor. The version it
 * replaces stays exactly as it was, like any other version.
 */
export const publishTemplateVersionFromBlocks = createServerFn({ method: "POST" })
  .validator((input: { templateId: string; name: string; blocks: unknown }) => input)
  .handler(
    async ({ data }): Promise<Result<Template>> =>
      attempt(async () => {
        assertSameOrigin();

        const templateId = String(data.templateId ?? "");
        if (templateId === "") throw new NotFoundError();

        const { tree, problems } = checkedContent(data.blocks);
        if (problems.length > 0) throw new ValidationError(problems);

        const file = templateFile(tree, String(data.name ?? ""));
        const fileProblems = validateTemplateFile(file);
        if (fileProblems.length > 0) {
          throw new ValidationError(fileProblems.map((problem) => ({ ...problem, field: "content" })));
        }

        return sessions().authorize(callContext(), (ctx) =>
          docgen().templates.addVersion(ctx, templateId, file),
        );
      }),
  );

export const listTemplateVersions = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(
    async ({ data }): Promise<Result<TemplateVersion[]>> =>
      attempt(() =>
        sessions().authorize(callContext(), async (ctx) => {
          const { items } = await collectPages((page) =>
            docgen().templates.versions(ctx, data, page),
          );
          return [...items];
        }),
      ),
  );

/**
 * Publishes a new version of an existing template from another .docx.
 *
 * This is what editing a template means here. A template that came from Word is
 * never rewritten from the block tree the preview reads — that would lose every
 * piece of formatting the reader does not model — so a change is always a new
 * version, and the one it replaces stays exactly as it was.
 *
 * FormData rather than an object holding a File: createTemplate already proves
 * that path through the framework's serialiser, and the template id rides along
 * in the same form because a validator takes a single value.
 */
export const publishTemplateVersion = createServerFn({ method: "POST" })
  .validator((form: FormData) => form)
  .handler(
    async ({ data }): Promise<Result<Template>> =>
      attempt(async () => {
        assertSameOrigin();

        const templateId = String(data.get("templateId") ?? "");
        if (templateId === "") {
          throw fieldError("file", "Modelo não informado.");
        }

        const file = data.get("file");
        if (!(file instanceof File)) {
          throw fieldError("file", "Escolha um arquivo .docx.");
        }

        // Only the file is checked: a new version inherits the name and the
        // description of the template it belongs to.
        const problems = validateTemplateFile(file);
        if (problems.length > 0) throw new ValidationError(problems);

        return sessions().authorize(callContext(), (ctx) =>
          docgen().templates.addVersion(ctx, templateId, file),
        );
      }),
  );

/**
 * Removes a template.
 *
 * The API deletes it softly: it disappears from every route that reads one,
 * while the versions behind already-generated documents are retained, so those
 * documents stay downloadable. The confirmation copy says so, because someone
 * deciding whether to delete needs to know it.
 */
export const deleteTemplate = createServerFn({ method: "POST" })
  .validator((id: string) => id)
  .handler(
    async ({ data }): Promise<Result<null>> =>
      attempt(async () => {
        assertSameOrigin();

        await sessions().authorize(callContext(), (ctx) =>
          docgen().templates.remove(ctx, data),
        );
        // A resolved void would type as Result<void>; null is a value the
        // caller can branch on, which is what logout settled on too.
        return null;
      }),
  );

/**
 * A template together with a readable rendering of its content.
 *
 * The blocks are for showing the document, never for rewriting it: they model
 * paragraphs, heading level and emphasis, and nothing else. Generation still
 * happens in the API against the original archive, so what this leaves out
 * cannot reach the file a user downloads.
 */
export interface TemplateContent {
  readonly template: Template;
  readonly blocks: readonly Block[];
  /** Every version, newest first, so a caller can offer the choice. */
  readonly versions: readonly TemplateVersion[];
  /**
   * True when the listing reached the cap of `collectPages`, so older versions
   * may exist beyond it. Every page up to that cap is read.
   */
  readonly versionsTruncated: boolean;
  /** True when the content could not be read; the form still works without it. */
  readonly previewUnavailable: boolean;
  /**
   * True when the version was written in the block editor and its stored tree
   * still describes the document, so the editor can open it without losing
   * anything. A template from Word, or one changed in Word after the editor
   * wrote it, is not editable.
   */
  readonly editable: boolean;
}

/**
 * Loads a template for the generation screen, optionally pinned to a version.
 *
 * Without a version this describes the latest, which is what the API reports on
 * its own. With one, that version's metadata has to come from the listing —
 * `get` only ever describes the newest — and the template comes back with its
 * `version` replaced by the chosen one. That substitution is what lets every
 * reader downstream go on asking for `template.version` and receive the schema
 * that actually applies, while `latestVersion` still tells the truth about
 * where the template stands.
 */
export const getTemplateContent = createServerFn({ method: "GET" })
  .validator((input: { id: string; version?: number }) => input)
  .handler(
    async ({ data }): Promise<Result<TemplateContent>> =>
      attempt(() =>
        sessions().authorize(callContext(), async (ctx) => {
          const [latest, listing] = await Promise.all([
            docgen().templates.get(ctx, data.id),
            // Every version, not the first page: a template pinned to an old
            // version must still open, and the picker must offer all of them.
            collectPages((page) => docgen().templates.versions(ctx, data.id, page)),
          ]);
          const versions = [...listing.items];

          const selected =
            data.version === undefined
              ? latest.version
              : versions.find((v) => v.version === data.version);

          // A version that does not exist is a wrong address, not an empty
          // screen: the route renders the load failure rather than a form with
          // no fields in it.
          if (selected === undefined) {
            throw new NotFoundError();
          }

          const template: Template = { ...latest, version: selected };

          try {
            const archive = await docgen().templates.downloadVersion(
              ctx,
              template.id,
              selected.version,
            );
            const document = parseDocx(archive);
            const source = storedTree(archive);
            // The stored tree is exact where the reader is approximate, so it
            // is also the better preview, but only while it still matches.
            const editable = source !== null && describesDocument(source, document);
            return {
              template,
              versions,
              versionsTruncated: listing.truncated,
              blocks: editable ? source : document,
              previewUnavailable: false,
              editable,
            };
          } catch (error) {
            // A document this reader cannot make sense of must not cost the
            // user the ability to generate: the API renders from the original
            // archive regardless of what the preview managed to show.
            console.error("could not read template content for preview", error);
            return {
              template,
              versions,
              versionsTruncated: listing.truncated,
              blocks: [],
              previewUnavailable: true,
              editable: false,
            };
          }
        }),
      ),
  );

/** The tree the block editor stored in an archive, or null. */
function storedTree(archive: Uint8Array): Block[] | null {
  const part = readZipEntry(archive, SOURCE_PART);
  return part === null ? null : parseBlockSource(new TextDecoder().decode(part));
}
