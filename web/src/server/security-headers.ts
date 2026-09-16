/**
 * The response headers that defend the page itself.
 *
 * The LGPD asks a controller for technical measures able to protect personal
 * data (art. 46). These are the cheapest and most legible ones a web
 * application has: they cost one file, they apply to every response, and they
 * are visible to anyone auditing the service from the outside.
 *
 * The policy is only this strict because the fonts are served from this
 * origin. A font loaded from Google would make `default-src 'self'` impossible
 * and send every visitor's address to a third party on every page view.
 */

import { createMiddleware } from "@tanstack/react-start";

import { getConfig } from "../infrastructure/config.ts";

/**
 * The Content-Security-Policy.
 *
 * `'unsafe-inline'` on styles and scripts is not decoration: the framework
 * inlines the dehydrated router state and a small bootstrap into the served
 * HTML, and this platform also inlines the script that applies the reader's
 * theme before first paint. Removing it needs a per-request nonce threaded
 * through the framework's own script tags, which is recorded as a follow-up
 * rather than guessed at here.
 *
 * What it still buys: no external origin can load code, styles, fonts or
 * frames into this page, `frame-ancestors 'none'` makes it unembeddable,
 * `form-action 'self'` stops a form being retargeted at another host, and
 * `base-uri 'self'` stops a `<base>` tag rewriting every relative URL.
 */
function contentSecurityPolicy(development: boolean): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // The dev server serves modules over a websocket and evaluates them, which
    // production never does.
    development
      ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self' 'unsafe-inline'",
    development ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
  ];
  return directives.join("; ");
}

/**
 * Applies the headers to every response, page and server function alike.
 *
 * A request middleware rather than a per-route concern: a header that protects
 * some responses and not others is a header nobody can rely on.
 */
export const securityHeaders = createMiddleware({ type: "request" }).server(
  async ({ next, handlerType }) => {
    const result = await next();
    const { isProduction } = getConfig();
    const headers = result.response.headers;

    headers.set("Content-Security-Policy", contentSecurityPolicy(!isProduction));

    // Belt to the CSP's braces, for the browsers and scanners that read this
    // one and not `frame-ancestors`.
    headers.set("X-Frame-Options", "DENY");
    headers.set("X-Content-Type-Options", "nosniff");

    // A server function's response carries account data. None of it belongs in
    // a shared cache or on disk in a browser cache, so they are marked
    // uncacheable in one place rather than one function at a time.
    if (handlerType === "serverFn") {
      headers.set("Cache-Control", "no-store");
    }

    // Send the origin to other sites, never the path: a path here will carry a
    // contract or a person's identifier, which has no business leaving with a
    // click.
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

    // Nothing in this product uses any of them, so nothing should be able to
    // ask, including a script that got in some other way.
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");

    // Only over HTTPS. In development the dev server speaks plain HTTP, and a
    // browser that honoured this there would refuse to load the site at all
    // until the header expired.
    if (isProduction) {
      headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    return result;
  },
);
