/**
 * The head tags a public page needs to be found and shared well.
 *
 * Gathered here rather than written out per route, because the failure mode of
 * copying them is a page that quietly lacks one — which is exactly how this
 * platform ended up with five public pages and no canonical, no Open Graph and
 * no sitemap while every one of them had a careful title.
 */

/**
 * Where this deployment is served.
 *
 * Public information, not a secret, so it is a build-time constant rather than
 * a server-only setting: the canonical URL and the sharing tags have to be in
 * the HTML the browser receives, which rules out anything the server keeps to
 * itself.
 */
export const SITE_URL = (
  import.meta.env["VITE_SITE_URL"] ?? "https://docs.imobiliary.com"
).replace(/\/+$/, "");

/** The absolute address of a path on this site. */
export function absoluteUrl(path: string): string {
  return SITE_URL + (path === "/" ? "/" : path.replace(/\/+$/, ""));
}

/** The sharing image, served from public/. */
const OG_IMAGE = {
  path: "/og-image.png",
  width: 1200,
  height: 630,
  alt: "imobiliary docs: Seus contratos, preenchidos sozinhos.",
} as const;

export interface PageSeo {
  readonly title: string;
  readonly description: string;
  /** The route's own path, used for the canonical address. */
  readonly path: string;
  /**
   * Keeps the page out of search results.
   *
   * For pages that exist to be used rather than found — a sign-in form has
   * nothing to offer someone arriving from a search, and indexing it competes
   * with the page that does.
   */
  readonly noindex?: boolean;
}

/**
 * Builds the meta and link tags for one public page.
 *
 * Open Graph and the Twitter card are not decoration: without them a link
 * pasted into WhatsApp or LinkedIn renders as a bare URL, and this is a product
 * people pass to each other. That costs more traffic day to day than ranking
 * does.
 *
 * The image is `public/og-image.png`, 1200×630: the size WhatsApp, LinkedIn
 * and X all crop from without losing the text. It is the same for every page,
 * so it names the product rather than the page. Its source is an HTML page
 * rendered by a headless browser; regenerate it rather than editing the PNG.
 */
export function pageSeo(seo: PageSeo) {
  const url = absoluteUrl(seo.path);
  const image = absoluteUrl(OG_IMAGE.path);

  const meta = [
    { title: seo.title },
    { name: "description", content: seo.description },

    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "Imobiliary Docs" },
    { property: "og:locale", content: "pt_BR" },
    { property: "og:title", content: seo.title },
    { property: "og:description", content: seo.description },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:width", content: String(OG_IMAGE.width) },
    { property: "og:image:height", content: String(OG_IMAGE.height) },
    { property: "og:image:alt", content: OG_IMAGE.alt },

    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: seo.title },
    { name: "twitter:description", content: seo.description },
    { name: "twitter:image", content: image },
    { name: "twitter:image:alt", content: OG_IMAGE.alt },
  ];

  if (seo.noindex === true) {
    meta.push({ name: "robots", content: "noindex, follow" });
  }

  return {
    meta,
    // Canonical on every page, including the ones that look like they could
    // not be reached two ways: the landing page already answers at "/" and at
    // "" and now varies by visitor, and a trailing slash is a duplicate to a
    // crawler even when it is the same file to us.
    links: [{ rel: "canonical", href: url }],
  };
}
