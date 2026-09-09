import type { ReactNode } from "react";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";

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
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href:
          "https://fonts.googleapis.com/css2" +
          "?family=Figtree:wght@400;500;600;700" +
          "&family=JetBrains+Mono:wght@400;500" +
          "&display=swap",
      },
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
    <html lang="pt-BR" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
