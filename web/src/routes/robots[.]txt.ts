import { createFileRoute } from "@tanstack/react-router";

import { absoluteUrl } from "@/lib/seo";

/**
 * The first file a crawler asks for.
 *
 * Served by a route handler rather than dropped in `public/`, because the
 * sitemap address has to be absolute and this deployment's own origin is the
 * only honest source for it. It also keeps both files answering the same way
 * in development and in production, where serving `public/` depends on the
 * host.
 *
 * A route with a `server` handler must not also have a `component`: with one,
 * the handler is allowed to defer, and a missing return then falls through to
 * rendering instead of failing.
 *
 * The private areas are listed even though every one of them will redirect an
 * anonymous visitor to sign-in. Saying so up front spares the crawl, and the
 * paths are not a secret.
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
            "Disallow: /imoveis",
            "Disallow: /pessoas",
            "Disallow: /contratos",
            "Disallow: /alugueis",
            "Disallow: /ajustes",
            "",
            "# Reached only from a private link, and the address carries a token.",
            "Disallow: /redefinir-senha",
            "Disallow: /convite",
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
