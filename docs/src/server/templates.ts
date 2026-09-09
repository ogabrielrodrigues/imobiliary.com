/**
 * Template operations, exposed to the browser as server functions.
 *
 * Every call goes through `sessions().authorize`, which is what guarantees a
 * spent access token is refreshed once, under single-flight, before the API
 * ever sees it.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import { fieldError } from "../domain/errors.ts";
import {
  validateTemplateUpload,
  type Template,
} from "../domain/template.ts";
import type { Block } from "../domain/block.ts";
import { parseDocx } from "../infrastructure/docx/parse.ts";
import { assertSameOrigin, callContext, docgen, sessions } from "./runtime.ts";

export const listTemplates = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<Template[]>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        docgen().templates.list(ctx),
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
  /** True when the content could not be read; the form still works without it. */
  readonly previewUnavailable: boolean;
}

export const getTemplateContent = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(
    async ({ data }): Promise<Result<TemplateContent>> =>
      attempt(() =>
        sessions().authorize(callContext(), async (ctx) => {
          const template = await docgen().templates.get(ctx, data);

          if (template.version === undefined) {
            return { template, blocks: [], previewUnavailable: true };
          }

          try {
            const archive = await docgen().templates.downloadVersion(
              ctx,
              template.id,
              template.version.version,
            );
            return {
              template,
              blocks: parseDocx(archive),
              previewUnavailable: false,
            };
          } catch (error) {
            // A document this reader cannot make sense of must not cost the
            // user the ability to generate: the API renders from the original
            // archive regardless of what the preview managed to show.
            console.error("could not read template content for preview", error);
            return { template, blocks: [], previewUnavailable: true };
          }
        }),
      ),
  );

export const getTemplate = createServerFn({ method: "GET" })
  .inputValidator((id: string) => id)
  .handler(
    async ({ data }): Promise<Result<Template>> =>
      attempt(() =>
        sessions().authorize(callContext(), (ctx) =>
          docgen().templates.get(ctx, data),
        ),
      ),
  );
