import { createFileRoute } from "@tanstack/react-router";

import { absoluteUrl } from "@/lib/seo";

/**
 * The pages worth indexing, and nothing else.
 *
 * A page carrying `noindex` is left out: listing one in a sitemap while
 * telling crawlers not to index it is a contradiction they report as an error.
 * The guarded routes are absent for the same reason they are in `robots.txt`.
 *
 * `lastModified` is only claimed where it is actually known. Inventing today's
 * date on every request would tell crawlers the site changes daily when it
 * does not. The legal texts bring their own effective date in phase 1.
 */
const PAGES: readonly { path: string; priority: string; lastModified?: string }[] = [
  { path: "/", priority: "1.0" },
];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => {
        const entries = PAGES.map((page) => {
          const lastModified =
            page.lastModified === undefined ? "" : `    <lastmod>${page.lastModified}</lastmod>\n`;

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
