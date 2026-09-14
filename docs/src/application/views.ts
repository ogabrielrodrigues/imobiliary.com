/**
 * View models: shapes the interface needs that no single API call returns.
 *
 * Assembling them on the server is the point of having a server layer. Doing it
 * in the browser would mean shipping a second round trip and the joining logic
 * along with it.
 */

import type { Batch } from "../domain/batch.ts";
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

/**
 * One page of the documents list.
 *
 * The API reports no total, so whether a next page exists is learned by asking
 * for one row more than is shown.
 */
export interface DocumentPage {
  readonly items: readonly DocumentListItem[];
  /** Zero-based. */
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
}

/** One entry of the history, with the name of the template behind it. */
export type HistoryItem =
  | { readonly kind: "document"; readonly item: DocumentListItem }
  | { readonly kind: "batch"; readonly batch: Batch; readonly templateName: string | null };

/** A template as a filter offers it. */
export interface TemplateOption {
  readonly id: string;
  readonly name: string;
}

/**
 * One page of the history. `templates` lists the active templates for the
 * filter, read in the same round trip because the page needs both.
 */
export interface HistoryPage {
  readonly items: readonly HistoryItem[];
  /** Zero-based. */
  readonly page: number;
  readonly pageSize: number;
  readonly hasNext: boolean;
  readonly templates: readonly TemplateOption[];
}

/** Everything the dashboard shows: the figures, and the latest documents. */
export interface DashboardView {
  readonly stats: DashboardStats;
  readonly recent: readonly DocumentListItem[];
}
