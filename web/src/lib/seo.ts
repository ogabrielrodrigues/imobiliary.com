/**
 * The head tags a public page needs to be found and shared well.
 *
 * Gathered here rather than written out per route, because the failure mode of
 * copying them is a page that quietly lacks one. Adding a public route means
 * calling `pageSeo`; writing the meta by hand is how a page ends up with no
 * canonical.
 */

/**
 * Where this deployment is served.
 *
 * Public information, not a secret, so it is a build-time constant rather than
 * a server-only setting: the canonical address and the sharing tags have to be
 * in the HTML the browser receives, which rules out anything the server keeps
 * to itself.
 */
export const SITE_URL = (
  import.meta.env["VITE_SITE_URL"] ?? "https://imobiliary.com"
).replace(/\/+$/, "");

/** The absolute address of a path on this site. */
export function absoluteUrl(path: string): string {
  return SITE_URL + (path === "/" ? "/" : path.replace(/\/+$/, ""));
}

export interface PageSeo {
  readonly title: string;
  readonly description: string;
  /** The route's own path, used for the canonical address. */
  readonly path: string;
  /**
   * Keeps the page out of search results.
   *
   * For pages that exist to be used rather than found: a sign-in form has
   * nothing to offer someone arriving from a search, and indexing it competes
   * with the page that does.
   */
  readonly noindex?: boolean;
}

/**
 * Builds the meta and link tags for one public page.
 *
 * Open Graph and the Twitter card are not decoration: without them a link
 * pasted into WhatsApp or LinkedIn renders as a bare address, and this is a
 * product people pass to each other.
 *
 * There is deliberately no `og:image` yet. A card without one still renders;
 * one pointing at a file that does not exist shows a broken frame. It needs a
 * 1200×630 image, which is a design decision rather than a code one.
 */
export function pageSeo(seo: PageSeo) {
  const url = absoluteUrl(seo.path);

  const meta = [
    { title: seo.title },
    { name: "description", content: seo.description },

    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "Imobiliary" },
    { property: "og:locale", content: "pt_BR" },
    { property: "og:title", content: seo.title },
    { property: "og:description", content: seo.description },
    { property: "og:url", content: url },

    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: seo.title },
    { name: "twitter:description", content: seo.description },
  ];

  if (seo.noindex === true) {
    meta.push({ name: "robots", content: "noindex, follow" });
  }

  return {
    meta,
    // Canonical on every page, including the ones that look like they could
    // not be reached two ways: a trailing slash is a duplicate to a crawler
    // even when it is the same file to us.
    links: [{ rel: "canonical", href: url }],
  };
}
