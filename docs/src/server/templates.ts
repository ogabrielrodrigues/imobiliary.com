/**
 * Template operations, exposed to the browser as server functions.
 *
 * Every call goes through `sessions().authorize`, which is what guarantees a
 * spent access token is refreshed once, under single-flight, before the API
 * ever sees it.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { fieldError, NotFoundError, ValidationError } from "../domain/errors.ts";
import {
  validateTemplateFile,
  validateTemplateUpload,
  type Template,
  type TemplateVersion,
} from "../domain/template.ts";
import type { Block } from "../domain/block.ts";
import { parseDocx } from "../infrastructure/docx/parse.ts";
import { assertSameOrigin, callContext, docgen, sessions } from "./runtime.ts";

/** How many versions a picker asks for at once. */
const VERSION_PAGE_LIMIT = 100;

/**
 * How many templates the list asks for: the API's largest page. The search on
 * that screen runs over what was fetched, since the API offers none, so the
 * list takes as much as one request allows; the screen says when it may have
 * been cut short.
 */
export const TEMPLATE_LIST_LIMIT = 100;

export const listTemplates = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<Template[]>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        docgen().templates.list(ctx, { limit: TEMPLATE_LIST_LIMIT }),
      ),
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
  .inputValidator((form: FormData) => form)
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

export const listTemplateVersions = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(
    async ({ data }): Promise<Result<TemplateVersion[]>> =>
      attempt(() =>
        sessions().authorize(callContext(), (ctx) =>
          docgen().templates.versions(ctx, data, { limit: VERSION_PAGE_LIMIT }),
        ),
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
  .inputValidator((form: FormData) => form)
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
  .inputValidator((id: string) => id)
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
  /** True when the content could not be read; the form still works without it. */
  readonly previewUnavailable: boolean;
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
  .inputValidator((input: { id: string; version?: number }) => input)
  .handler(
    async ({ data }): Promise<Result<TemplateContent>> =>
      attempt(() =>
        sessions().authorize(callContext(), async (ctx) => {
          const [latest, versions] = await Promise.all([
            docgen().templates.get(ctx, data.id),
            docgen().templates.versions(ctx, data.id, {
              limit: VERSION_PAGE_LIMIT,
            }),
          ]);

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
            return {
              template,
              versions,
              blocks: parseDocx(archive),
              previewUnavailable: false,
            };
          } catch (error) {
            // A document this reader cannot make sense of must not cost the
            // user the ability to generate: the API renders from the original
            // archive regardless of what the preview managed to show.
            console.error("could not read template content for preview", error);
            return {
              template,
              versions,
              blocks: [],
              previewUnavailable: true,
            };
          }
        }),
      ),
  );
