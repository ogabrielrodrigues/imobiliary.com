import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: {
    // 3000 belongs to the document platform, which runs beside this one.
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
    // There is only one React on disk, but Vite's dependency pre-bundling can
    // still hand out a second module instance — enough for React's dispatcher
    // to come back null and every hook to fail with "more than one copy of
    // React". Deduping pins every importer, Base UI included, to one instance.
    dedupe: ["react", "react-dom"],
  },
  build: {
    /*
      Fonts are never inlined.

      Vite turns an asset under its inline limit into a data: URI, and one of
      the font faces is small enough. The browser then refuses it: the CSP says
      font-src 'self', and a data: URI is not 'self'. Only a production build
      shows this, because the dev server serves every asset as a file.

      Widening the policy to data: would be the other way out. Not inlining is
      the better one: the policy stays as narrow as it can be, and a font
      shipped as a file is cached on its own instead of riding inside the
      stylesheet on every visit.
    */
    assetsInlineLimit: (filePath) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
  },
  plugins: [
    // Tailwind runs first so the generated stylesheet is in place before the
    // framework plugins process the modules that import it.
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
