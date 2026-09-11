import type { ReactNode } from "react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
} from "@tanstack/react-router";

import { CookieNotice } from "@/components/cookie-notice";
import { bootScript } from "@/lib/accessibility-storage";
import appCss from "@/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Imobiliary Docs" },
      {
        name: "description",
        content:
          "Gere contratos, recibos e distratos a partir dos seus próprios " +
          "modelos do Word, com os dados preenchidos automaticamente.",
      },
      { name: "theme-color", content: "#0b0d10" },
    ],
    links: [
      // An SVG icon stays sharp at every size a browser asks for, and its
      // colours come from the design system rather than from a re-exported
      // bitmap that would drift from them.
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      // The fonts arrive with this stylesheet, from this origin. Loading them
      // from Google would hand every visitor's address and user agent to a
      // third party before the page had told them anything — and it was the
      // only external host the browser contacted.
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // The interface is written in Brazilian Portuguese; declaring it lets
    // screen readers pick the right voice and browsers offer the right
    // translation.
    //
    // suppressHydrationWarning: the head script below may set data-* attributes
    // on this element before React hydrates, on purpose.
    <html lang="pt-BR" className="dark" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/*
          The accessibility preferences, applied before first paint so that
          someone who asked for large text or high contrast never sees the page
          without it. Inline, so it is covered by the CSP's 'unsafe-inline' for
          now; it will need the nonce when that goes.
        */}
        <ScriptOnce>{bootScript()}</ScriptOnce>
      </head>
      <body>
        {children}
        {/* Every surface, signed in or not: the cookie is set either way. */}
        <CookieNotice />
        <Scripts />
      </body>
    </html>
  );
}
