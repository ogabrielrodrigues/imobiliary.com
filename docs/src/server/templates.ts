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
