/**
 * Generated-document operations, exposed as server functions.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import type { GeneratedDocument } from "../domain/document.ts";
import { callContext, docgen, sessions } from "./runtime.ts";

export const listDocuments = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<GeneratedDocument[]>> =>
    attempt(() =>
      sessions().authorize(callContext(), (ctx) =>
        docgen().documents.list(ctx),
      ),
    ),
);
