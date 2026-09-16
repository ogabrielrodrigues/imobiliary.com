/**
 * Checks the dependency rule, so it is verified rather than trusted.
 *
 * This is the counterpart of `go list -deps ./internal/domain` on the API side:
 * the layering only means something if something enforces it. Written against
 * node: builtins alone, so it costs no dependency.
 *
 *   node scripts/check-layers.mjs
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..", "src");

/**
 * Which layer each may reach into. The rule points inwards: the interface may
 * use the application, the application may use the domain, and the domain uses
 * nothing of ours at all.
 */
const RULES = [
  {
    layer: "domain",
    mayImport: ["domain"],
    because: "the domain must not know the application, the API or React",
  },
  {
    layer: "application",
    mayImport: ["domain", "application"],
    because:
      "the application declares the interfaces it needs; it must not reach " +
      "for an implementation",
  },
  {
    layer: "infrastructure",
    mayImport: ["domain", "application", "infrastructure"],
    because: "an adapter implements the ports, it does not drive the app",
  },
  {
    layer: "server",
    mayImport: ["domain", "application", "infrastructure", "server"],
    because: "the server layer is the composition root",
  },
  {
    layer: "queries",
    mayImport: ["domain", "application", "server", "queries"],
    because:
      "a query describes how to fetch through a server function and how to " +
      "cache it; it knows nothing of the screens that read it",
  },
  {
    layer: "routes",
    mayImport: ["domain", "application", "server", "queries", "components", "lib", "routes"],
    because:
      "a route must reach the API through a server function, never by " +
      "importing infrastructure and shipping it to the browser",
  },
  {
    layer: "components",
    mayImport: ["domain", "application", "server", "queries", "components", "lib", "routes"],
    because:
      "a component must not import infrastructure, which would risk bundling " +
      "server-only code into the page",
  },
];

const LAYERS = new Set(RULES.map((rule) => rule.layer));

/** Every .ts/.tsx file under a directory. */
async function* sourceFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // a layer that does not exist yet has nothing to check
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.tsx?$/.test(entry.name)) {
      yield path;
    }
  }
}

/** The import specifiers a file mentions, from static imports and re-exports. */
function specifiersOf(source) {
  const pattern = /(?:from|import)\s*["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

/**
 * The layer a specifier lands in, or null when it leaves our source tree — a
 * package, or a stylesheet.
 */
function layerOf(specifier, fromFile) {
  let candidate;

  if (specifier.startsWith("@/")) {
    candidate = specifier.slice("@/".length);
  } else if (specifier.startsWith(".")) {
    candidate = relative(SRC, resolve(fromFile, "..", specifier)).replaceAll(
      "\\",
      "/",
    );
  } else {
    return null;
  }

  const top = candidate.split("/")[0];
  return LAYERS.has(top) ? top : null;
}

const violations = [];

for (const rule of RULES) {
  const dir = join(SRC, rule.layer);

  for await (const file of sourceFiles(dir)) {
    const source = await readFile(file, "utf8");

    for (const specifier of specifiersOf(source)) {
      const target = layerOf(specifier, file);
      if (target === null || rule.mayImport.includes(target)) continue;

      violations.push(
        `${relative(SRC, file).replaceAll("\\", "/")}\n` +
          `  imports ${specifier} (layer: ${target})\n` +
          `  ${rule.layer} may only import ${rule.mayImport.join(", ")} — ${rule.because}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(`Dependency rule broken in ${violations.length} place(s):\n`);
  console.error(violations.join("\n\n"));
  process.exit(1);
}

console.log("Dependency rule holds.");
