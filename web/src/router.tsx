import { createRouter } from "@tanstack/react-router";

import { NotFound } from "./components/not-found.tsx";
import { routeTree } from "./routeTree.gen";

/**
 * Builds the router. TanStack Start calls this on the server for each request
 * and once in the browser, so it must stay free of module-level state that
 * could leak between requests. That is why everything per-request is created
 * inside it, which is where the QueryClient will go in phase 1.
 */
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // Without it an unknown address renders the router's bare "Not Found".
    defaultNotFoundComponent: NotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
