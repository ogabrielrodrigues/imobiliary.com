/**
 * View models: shapes the interface needs that no single API call returns.
 *
 * Assembling them on the server is the point of having a server layer. Doing it
 * in the browser would mean shipping a second round trip and the joining logic
 * along with it.
 */

import type { GeneratedDocument } from "../domain/document.ts";
import type { DashboardStats } from "../domain/stats.ts";

/**
 * A generated document together with the name of the template behind it.
 *
 * The API returns only the template's identifier, which tells a person nothing.
 * `templateName` is null when the name could not be resolved — the template was
 * deleted since, or it sits beyond the page of templates that was fetched — and
 * the interface says so rather than showing a bare id.
 */
export interface DocumentListItem {
  readonly document: GeneratedDocument;
  readonly templateName: string | null;
}

/** Everything the dashboard shows: the figures, and the latest documents. */
export interface DashboardView {
  readonly stats: DashboardStats;
  readonly recent: readonly DocumentListItem[];
}
