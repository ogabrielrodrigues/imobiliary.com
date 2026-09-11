import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { STALE_TIME_MS } from "./queries/keys.ts";
import { routeTree } from "./routeTree.gen";

/**
 * Builds the router. TanStack Start calls this on the server for each request
 * and once in the browser, so it must stay free of module-level state that
 * could leak between requests.
 *
 * That is why the QueryClient is created here and not at module level: on the
 * server a shared client would hand one account's cached templates to the next
 * request. One client per router means one per request on the server, and one
 * for the life of the tab in the browser.
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Coming back to a screen within this window shows what is cached
        // without asking the API again.
        staleTime: STALE_TIME_MS,
        // Expected failures are values (Result), so a query only throws on a
        // real fault — a dropped connection, a bug. Retrying those three
        // times with backoff would only delay the error screen.
        retry: false,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // The router always calls the loader; the query cache decides whether
    // that means a request. Two caches deciding separately would disagree.
    defaultPreloadStaleTime: 0,
  });

  // Dehydrates what the server fetched into the page and hydrates it in the
  // browser, so the first render does not fetch everything a second time.
  // It also provides the QueryClient to React.
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
