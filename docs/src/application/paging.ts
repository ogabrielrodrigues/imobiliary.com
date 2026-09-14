/**
 * Reading a whole listing out of an API that pages.
 *
 * The API answers at most 100 items per request and reports no total, so the
 * only way to know a listing is complete is a page that comes back short. The
 * cap keeps one screen from issuing unbounded requests on an account with an
 * extraordinary amount of data; `truncated` says when it was reached, so the
 * interface can say so instead of pretending the list is whole.
 */

import type { Page } from "./ports.ts";

/** The API's largest page. */
export const API_PAGE_SIZE = 100;

/** How many items a screen reads before it stops and says so. */
export const LISTING_CAP = 1000;

export interface Collected<T> {
  readonly items: readonly T[];
  /** True when the cap was reached and more may exist beyond it. */
  readonly truncated: boolean;
}

export async function collectPages<T>(
  fetchPage: (page: Page) => Promise<readonly T[]>,
  { pageSize = API_PAGE_SIZE, cap = LISTING_CAP }: { pageSize?: number; cap?: number } = {},
): Promise<Collected<T>> {
  const items: T[] = [];

  while (items.length < cap) {
    const limit = Math.min(pageSize, cap - items.length);
    const page = await fetchPage({ limit, offset: items.length });
    items.push(...page);

    // A short page is the end. A full one may be too, but only another
    // request can tell.
    if (page.length < limit) {
      return { items, truncated: false };
    }
  }

  return { items, truncated: true };
}
