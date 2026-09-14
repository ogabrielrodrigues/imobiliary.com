/**
 * The dashboard's data, exposed as a server function.
 */

import { createServerFn } from "@tanstack/react-start";

import { attempt, type Result } from "../application/result.ts";
import type { DashboardView } from "../application/views.ts";
import {
  DEFAULT_STATS_PERIOD,
  DEFAULT_TIME_ZONE,
  isStatsPeriod,
  type StatsPeriod,
} from "../domain/stats.ts";
import { callContext, docgen, sessions } from "./runtime.ts";

/** How many documents the dashboard lists as recent. */
const RECENT_DOCUMENTS = 5;

/** As in documents.ts: enough to name the templates behind recent documents. */
const TEMPLATE_NAME_LOOKUP_LIMIT = 100;

/** Longest IANA zone name worth forwarding; the real ones are far shorter. */
const MAX_TIME_ZONE_LENGTH = 64;

/**
 * Everything the dashboard shows, in one round trip from the browser: the
 * figures, the most recent documents, and the names of the templates behind
 * them. The three API calls run in parallel.
 *
 * Input is normalised rather than rejected: an unknown window falls back to the
 * default, and the zone goes to the API, which has the last word on it.
 */
export const getDashboard = createServerFn({ method: "GET" })
  .validator(
    (input: { days?: number; timeZone?: string }): { days: StatsPeriod; timeZone: string } => ({
      days: isStatsPeriod(input.days) ? input.days : DEFAULT_STATS_PERIOD,
      timeZone:
        typeof input.timeZone === "string" &&
        input.timeZone.length > 0 &&
        input.timeZone.length <= MAX_TIME_ZONE_LENGTH
          ? input.timeZone
          : DEFAULT_TIME_ZONE,
    }),
  )
  .handler(
    async ({ data }): Promise<Result<DashboardView>> =>
      attempt(() =>
        sessions().authorize(callContext(), async (ctx) => {
          const [stats, documents, templates] = await Promise.all([
            docgen().stats.get(ctx, data),
            docgen().documents.list(ctx, { limit: RECENT_DOCUMENTS }),
            docgen().templates.list(ctx, { limit: TEMPLATE_NAME_LOOKUP_LIMIT }),
          ]);

          const names = new Map(templates.map((t) => [t.id, t.name]));

          return {
            stats,
            recent: documents.map((document) => ({
              document,
              templateName: names.get(document.templateId) ?? null,
            })),
          };
        }),
      ),
  );
