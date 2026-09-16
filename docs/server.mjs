/**
 * The production server.
 *
 * `vite build` produces two things: `dist/client`, the files the browser
 * downloads, and `dist/server/server.js`, which default-exports a web `fetch`
 * handler. A fetch handler is not a server: it listens to nothing and it
 * serves no files. Hosts that take a handler directly supply the rest; a
 * deployment on a machine of our own has to, and this file is that missing
 * part.
 *
 * srvx is the adapter. It is the same one the Vite ecosystem uses, it was
 * already on disk as a transitive dependency, and it converts between Node's
 * streams and the web Request and Response — the part that is easy to write
 * and hard to write correctly.
 *
 *   node server.mjs
 *
 * PORT and HOST configure it. It binds to loopback by default: a TLS
 * terminating proxy belongs in front in any case, and the API this talks to
 * refuses to trust a forwarded address without one.
 */

import { serve } from "srvx";
import { serveStatic } from "srvx/static";

import handler from "./dist/server/server.js";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

const server = serve({
  port,
  hostname,
  // Static files first: an asset must never reach the router, which would
  // render a 404 page for a missing stylesheet.
  middleware: [serveStatic({ dir: "./dist/client" })],
  fetch: handler.fetch,
});

await server.ready();
console.log(`imobiliary docs listening on http://${hostname}:${port}`);
