/**
 * Template operations, exposed to the browser as server functions.
 *
 * Every call goes through `sessions().authorize`, which is what guarantees a
 * spent access token is refreshed once, under single-flight, before the API
 * ever sees it.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import type { Template } from "../domain/template.ts";
import { callContext, docgen, sessions } from "./runtime.ts";

export const listTemplates = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<Template[]>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        docgen().templates.list(ctx),
      ),
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
