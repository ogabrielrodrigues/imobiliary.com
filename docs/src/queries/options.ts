/**
 * Query options: one factory per read, shared by the loader that warms the
 * cache and the component that reads from it.
 *
 * The data is the server function's `Result<T>`, as before. An expected
 * failure is a value the screen renders, not an error the query throws, so the
 * screens branch on `result.ok` exactly as they did with loader data.
 */

import { infiniteQueryOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { getDashboard } from "../server/dashboard.ts";
import { getHistory, listBatchDocuments } from "../server/history.ts";
import { getTemplateContent, listTemplates } from "../server/templates.ts";
import type { StatsPeriod } from "../domain/stats.ts";
import { queryKeys, staleAfter, type Change } from "./keys.ts";

/**
 * Marks what a change made stale. Queries on screen refetch at once; the rest
 * refetch the next time a screen asks for them.
 */
export async function invalidateAfter(queryClient: QueryClient, change: Change) {
  await Promise.all(
    staleAfter[change].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

export function templateListQuery() {
  return queryOptions({
    queryKey: queryKeys.templateList(),
    queryFn: () => listTemplates(),
  });
}

export function templateContentQuery(id: string, version: number | undefined) {
  return queryOptions({
    queryKey: queryKeys.templateContent(id, version),
    queryFn: () =>
      getTemplateContent({
        data: { id, ...(version === undefined ? {} : { version }) },
      }),
  });
}

export function historyPageQuery(page: number, templateId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.historyPage(page, templateId),
    queryFn: () =>
      getHistory({ data: { page, ...(templateId === undefined ? {} : { templateId }) } }),
  });
}

/**
 * The documents of one batch, a page at a time. Read only when the batch's row
 * is opened, so a history of large batches costs nothing until someone looks.
 */
export function batchDocumentsQuery(batchId: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.batchDocuments(batchId),
    queryFn: ({ pageParam }) => listBatchDocuments({ data: { batchId, page: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.ok && last.value.hasNext ? last.value.page + 1 : undefined),
  });
}

export function dashboardQuery(days: StatsPeriod, timeZone: string) {
  return queryOptions({
    queryKey: queryKeys.dashboardView(days, timeZone),
    queryFn: () => getDashboard({ data: { days, timeZone } }),
  });
}
