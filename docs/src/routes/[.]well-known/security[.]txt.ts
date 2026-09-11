import { createFileRoute } from "@tanstack/react-router";

import { CONTROLLER } from "@/domain/legal";
import { absoluteUrl } from "@/lib/seo";

/**
 * When this file was last reviewed. Expires is set a year after it, as RFC 9116
 * asks: a security.txt whose Expires lies in the past tells a researcher the
 * contact may be dead. Bump this date whenever the contact is confirmed.
 */
const REVIEWED = "2026-09-10";

function expires(): string {
  const date = new Date(`${REVIEWED}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
}

/**
 * Where a researcher who found something is supposed to look first.
 *
 * Served by a route handler for the same reason robots.txt is: the canonical
 * address has to be absolute, and serving public/ in production depends on the
 * host. The contact is the privacy address from the controller identity, so it
 * cannot drift from the one the privacy policy names — and production refuses
 * to start while that is still a placeholder.
 */
export const Route = createFileRoute("/.well-known/security.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          [
            `Contact: mailto:${CONTROLLER.privacyEmail}`,
            `Expires: ${expires()}`,
            "Preferred-Languages: pt, en",
            `Canonical: ${absoluteUrl("/.well-known/security.txt")}`,
            "",
          ].join("\n"),
          {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "public, max-age=86400",
            },
          },
        ),
    },
  },
});
