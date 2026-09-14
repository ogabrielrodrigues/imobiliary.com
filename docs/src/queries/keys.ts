/**
 * Query keys, and which of them each change makes stale.
 *
 * Kept apart from the query options so they can be tested without loading a
 * server function. Every key starts with its resource, which is what lets an
 * invalidation name a whole resource with one prefix.
 */

/** How long a fetched answer is considered fresh. */
export const STALE_TIME_MS = 30_000;

export const queryKeys = {
  templates: ["templates"] as const,
  templateList: () => ["templates", "list"] as const,
  templateContent: (id: string, version: number | undefined) =>
    ["templates", id, "content", version ?? "latest"] as const,

  documents: ["documents"] as const,
  /** The documents inside one batch, read page by page as the row is opened. */
  batchDocuments: (batchId: string) => ["documents", "batch", batchId] as const,

  history: ["history"] as const,
  historyPage: (page: number, templateId: string | undefined) =>
    ["history", page, templateId ?? "all"] as const,

  dashboard: ["dashboard"] as const,
  dashboardView: (days: number, timeZone: string) =>
    ["dashboard", days, timeZone] as const,
};

/**
 * What each change makes stale, as key prefixes.
 *
 * The dashboard counts both templates and documents, so it appears in every
 * entry that touches either. The history lists documents and names their
 * templates, so it follows both too.
 */
export const staleAfter = {
  templateCreated: [queryKeys.templates, queryKeys.history, queryKeys.dashboard],
  versionPublished: [queryKeys.templates, queryKeys.dashboard],
  templateDeleted: [queryKeys.templates, queryKeys.documents, queryKeys.history, queryKeys.dashboard],
  documentGenerated: [queryKeys.documents, queryKeys.history, queryKeys.dashboard],
  batchChanged: [queryKeys.documents, queryKeys.history, queryKeys.dashboard],
} as const satisfies Record<string, readonly (readonly unknown[])[]>;

export type Change = keyof typeof staleAfter;
