import type { ReactNode } from "react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
} from "@tanstack/react-router";

import { AppearanceSync } from "@/components/appearance-sync";
import { MAIN_CONTENT_ID, RouteAnnouncer } from "@/components/route-announcer";
import { bootScript } from "@/lib/accessibility-storage";
import appCss from "@/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Imobiliary" },
      {
        name: "description",
        content:
          "Gestão de imóveis para locação: contratos, reajustes e aluguéis " +
          "em um lugar só.",
      },
      // Tints the browser's own chrome on a phone. The head script rewrites it
      // to match whichever theme the reader chose.
      { name: "theme-color", content: "#0b0d10" },
    ],
    links: [
      // The fonts arrive with this stylesheet, from this origin. Loading them
      // from Google would hand every visitor's address and user agent to a
      // third party before the page had told them anything.
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // The interface is written in Brazilian Portuguese; declaring it lets
    // screen readers pick the right voice and browsers offer the right
    // translation.
    //
    // suppressHydrationWarning: the head script below sets data-* attributes
    // on this element before React hydrates, on purpose.
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/*
          The theme and accessibility preferences, resolved and applied before
          first paint, so someone who chose a light theme or large text never
          sees the default first.
        */}
        <ScriptOnce>{bootScript()}</ScriptOnce>
      </head>
      <body>
        {/*
          The first thing a keyboard reaches: hidden until focused, so a reader
          can skip the navigation on every page. Every layout gives its <main>
          the id it points at.
        */}
        <a
          href={`#${MAIN_CONTENT_ID}`}
          // Every visual class sits behind focus:. Padding outside it leaks
          // into the hidden state and gives sr-only a visible box.
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-small focus:font-semibold focus:text-primary-foreground"
        >
          Pular para o conteúdo
        </a>
        {children}
        <RouteAnnouncer />
        <AppearanceSync />
        <Scripts />
      </body>
    </html>
  );
}
