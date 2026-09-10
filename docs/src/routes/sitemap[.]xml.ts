import { createFileRoute } from "@tanstack/react-router";

import { absoluteUrl } from "@/lib/seo";
import { PRIVACY_POLICY, TERMS_OF_USE } from "@/domain/legal";

/**
 * The pages worth indexing, and nothing else.
 *
 * `/entrar` is absent on purpose: it carries a `noindex`, and listing a page in
 * a sitemap while telling crawlers not to index it is a contradiction they
 * report as an error. The guarded routes are absent for the same reason they
 * are in `robots.txt` — there is nothing behind them but a redirect.
 *
 * `lastModified` is only claimed where it is actually known. The legal texts
 * carry their own effective date; the landing page does not have a meaningful
 * one, and inventing today's date on every request would tell crawlers the site
 * changes daily when it does not.
 */
const PAGES: readonly { path: string; priority: string; lastModified?: string }[] =
  [
    { path: "/", priority: "1.0" },
    { path: "/criar-conta", priority: "0.8" },
    {
      path: "/privacidade",
      priority: "0.3",
      lastModified: PRIVACY_POLICY.effectiveFrom,
    },
    {
      path: "/termos",
      priority: "0.3",
      lastModified: TERMS_OF_USE.effectiveFrom,
    },
  ];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => {
        const entries = PAGES.map((page) => {
          const lastModified =
            page.lastModified === undefined
              ? ""
              : `    <lastmod>${page.lastModified}</lastmod>\n`;

          return (
            "  <url>\n" +
            `    <loc>${absoluteUrl(page.path)}</loc>\n` +
            lastModified +
            `    <priority>${page.priority}</priority>\n` +
            "  </url>\n"
          );
        }).join("");

        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
            entries +
            "</urlset>\n",
          {
            headers: {
              "Content-Type": "application/xml; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          },
        );
      },
    },
  },
});
