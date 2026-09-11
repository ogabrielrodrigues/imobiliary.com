import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
} from "@tanstack/react-router";

import { AppearanceSync } from "@/components/appearance-sync";
import { CookieNotice } from "@/components/cookie-notice";
import { MAIN_CONTENT_ID, RouteAnnouncer } from "@/components/route-announcer";
import { bootScript } from "@/lib/accessibility-storage";
import appCss from "@/styles/app.css?url";

/** What every route's loader receives, set where the router is built. */
export interface RouterContext {
  readonly queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
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
    // suppressHydrationWarning: the head script below sets data-* attributes
    // on this element before React hydrates, on purpose. There is no theme
    // class to render here: the theme is data-scheme, set by that script.
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/*
          The theme and accessibility preferences, resolved and applied before
          first paint so that someone who chose a light theme or large text
          never sees the default first. Inline, so it is covered by the CSP's
          'unsafe-inline' for now; it will need the nonce when that goes.
        */}
        <ScriptOnce>{bootScript()}</ScriptOnce>
      </head>
      <body>
        {/*
          The first thing a keyboard reaches: hidden until focused, then shown,
          so a reader can skip the navigation on every page. Every layout gives
          its <main> the id it points at.
        */}
        <a
          href={`#${MAIN_CONTENT_ID}`}
          // Every visual class sits behind focus:. Padding outside it leaks into
          // the hidden state and gives sr-only a visible box.
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-small focus:font-semibold focus:text-primary-foreground"
        >
          Pular para o conteúdo
        </a>
        {children}
        <RouteAnnouncer />
        <AppearanceSync />
        {/* Every surface, signed in or not: the cookie is set either way. */}
        <CookieNotice />
        <Scripts />
      </body>
    </html>
  );
}
