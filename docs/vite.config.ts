import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
    // There is only one React on disk, but Vite's dependency pre-bundling can
    // still hand out a second module instance — enough for React's dispatcher
    // to come back null and every hook to fail with "more than one copy of
    // React". Deduping pins every importer, Base UI included, to one instance.
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    // Tailwind runs first so the generated stylesheet is in place before the
    // framework plugins process the modules that import it.
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
