import { createFileRoute } from "@tanstack/react-router";

import { absoluteUrl } from "@/lib/seo";

/**
 * The first file a crawler asks for.
 *
 * Served by a route handler rather than dropped in `public/`, because the
 * sitemap address has to be absolute and this deployment's own origin is the
 * only honest source for it. It also keeps both files answering the same way in
 * development and in production, where serving `public/` depends on the host.
 *
 * The private areas are listed even though every one of them redirects an
 * anonymous visitor to sign-in. Saying so up front spares the crawl, and the
 * paths are not a secret — they are in the navigation of every signed-in page.
 */
export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          [
            "User-agent: *",
            "Allow: /",
            "",
            "# Behind sign-in: nothing here to index, and a crawler only meets",
            "# a redirect to the sign-in form.",
            "Disallow: /dashboard",
            "Disallow: /templates",
            "Disallow: /documentos",
            "Disallow: /ajustes",
            "Disallow: /meus-dados",
            "",
            `Sitemap: ${absoluteUrl("/sitemap.xml")}`,
            "",
          ].join("\n"),
          {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          },
        ),
    },
  },
});
