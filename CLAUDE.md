# CLAUDE.md

Working notes for this repository. Read this first — it carries the decisions
and the current position, so a fresh session can pick up without re-deriving
anything.

**Keep the "Status" section at the bottom current.** It is the handover.

---

## What this is

**Imobiliary** — property management for independent brokers, small agencies
and owners. This repository holds its document half:

| Directory | What | Runs at |
|---|---|---|
| `docgen-api/` | DOCX rendering API, Go | a private subdomain |
| `docs/` | web platform, TypeScript | `docs.imobiliary.com` |

`docgen` is the permanent **internal** name — module, packages, `DOCGEN_*` env
prefix. *Imobiliary Docs* is the **product** name and appears only in what users
see. There is no pending rename.

## Conventions

- **All code in English** — identifiers, comments, errors, test names, commit
  messages. Portuguese is for conversation with the user, and for
  `docgen-api/docgen.md`, which he asked for in Portuguese.
- Go: `gofmt`/`go vet` clean, errors wrapped with `%w`, `context.Context` first.
- TypeScript: `strict`, no `any`, no `dangerouslySetInnerHTML`.
- Dependencies are kept few and justified. Ask before adding one.

---

## docgen-api (done, don't break it)

Go 1.27.1. Three dependencies: `modernc.org/sqlite`, `golang-jwt/jwt/v5`,
`golang.org/x/crypto` (argon2id). Everything else is the standard library,
including the `uuid` package and `encoding/json/v2` that became stable in 1.27.

Clean Architecture: `adapter → usecase → domain`; `internal/domain` imports
nothing else from the module. Interfaces are declared in `usecase`, the
consumer.

### Facts a future session must not re-derive

- **Placeholders are flat.** `{{.customer_name}}` only — `simpleField` rejects
  nested fields and `IsValidPlaceholderName` enforces `^[a-z][a-z0-9_]*$`.
  No pipelines, functions, variables, `if` or `range`.
- **Word splits placeholders across runs.** A normalisation pass reassembles
  them at upload (`internal/adapter/docx/normalize.go`). This is the single
  hardest part of the engine and it is already solved and tested.
- **Unknown zip parts survive.** `Normalize` and `Render` copy any part that
  isn't `word/document.xml` or a header/footer through untouched
  (`docx.go:66`, `:175`). An embedded `imobiliary/source.json` round-trips byte
  for byte — proven by `TestDownloadTemplateVersionPreservesExtraParts`.
- **Substituted values are XML-escaped.** Skipping that produces files Word
  refuses to open.
- **Password minimum is 12**, not 8. The design system says 8; the design is
  wrong and its copy should be corrected.
- **Generation is synchronous.** A document is created or the request fails.
  There is no draft, no archive, no stored failure, no async job.
- **Refresh tokens rotate and replay revokes the whole chain.**

### Verification

```bash
cd docgen-api && gofmt -l . && go vet ./... && go test ./... && go test -tags=integration ./...
```

`go test -race` has never run: it needs cgo and there is no C compiler on this
machine. Run it wherever one exists.

---

## docs (the platform)

TanStack Start 1.x (stable since March 2026, a Vite plugin — not Vinxi),
React, TypeScript strict, pnpm.

Confirmed versions: `@tanstack/react-start` 1.168.50, `@tanstack/react-router`
1.170.33, `vite` 8.2.2, `tailwindcss` 4.3.3, `shadcn` CLI 4.21.0.

Scaffold: `shadcn init -b base -t start` — `-b base` selects **Base UI** as the
component base (not Radix), `-t start` the framework template.

### Scaffold gotchas already paid for

- **TypeScript 7 removed `baseUrl`.** Path aliases resolve relative to
  `tsconfig.json` now; adding `baseUrl` back is a hard error.
- **`shadcn init` prompts for a preset even with `-y`.** Pass `-p nova`
  (Lucide icons) or it blocks forever in a non-interactive shell.
- **`shadcn init` appends its own palette and overrides the theme.** It wrote a
  light `:root`, a `.dark` block, and an `@theme inline` that replaced the font
  with Geist and the colours with greys. `src/styles/app.css` has since been
  rewritten by hand: the design palette lives once in `:root`, `@theme inline`
  maps it onto Tailwind's colour utilities, and `<html>` carries `class="dark"`
  so the `dark:` variants shadcn's components are written with resolve as their
  authors intended rather than falling through to a light branch. **Re-running
  `shadcn init` would clobber this again** — only run `shadcn add`.
- Dependencies it pulled in: `@base-ui/react` (the point of `-b base`),
  `class-variance-authority`, `cn`, `lucide-react`, `tw-animate-css`, and
  `shadcn` itself for `shadcn/tailwind.css`. `@fontsource-variable/geist` was
  removed — the design calls for Figtree, loaded from Google Fonts in
  `__root.tsx`.

### Architecture

```
docs/src/
├── domain/          entities and rules; zero framework imports
├── application/     use cases + the ports they consume
├── infrastructure/  api client, session cookie, docx parse/build
├── server/          TanStack Start server functions — the only API boundary
├── ui/              components; ui/components/ui is shadcn output
└── routes/          file-based routes
```

Same dependency rule as the Go side, verified by a script rather than trusted.

### Decisions and why

**BFF, not a browser client.** Access and refresh tokens live in one httpOnly,
`Secure`, `SameSite=Lax` cookie encrypted with AES-GCM (`node:crypto`). Page
JavaScript never sees a token, so an XSS cannot steal a session.

**Refresh needs single-flight.** The API revokes the entire chain when a
consumed refresh token is replayed. Two concurrent requests expiring together
would both try to rotate, and the loser would destroy the user's session. Share
one in-flight rotation per session; on a 401 from refresh, clear the cookie and
send the user to login rather than retrying.

**Forward `X-Forwarded-For`.** Otherwise the API sees only the platform
server's IP and the per-IP rate limit collapses into one bucket for everybody.
Requires `DOCGEN_TRUST_PROXY_HEADERS=true` on the API — which in turn requires
the API to be unreachable from outside, or the header becomes forgeable.

**CSRF:** `SameSite=Lax` plus an `Origin` check on every mutating server
function.

### The UI direction: 1b, the live document

Two columns — template list, then the document rendered with placeholders as
chips you click to fill in place. A collapsible field panel acts as a checklist.

**The preview is a view, never the source of truth.** Values fill placeholders;
generation still happens in the API against the original, untouched `.docx`. So
preview fidelity cannot affect output fidelity, which is what allows a
deliberately simple extractor:

- templates authored here → read `imobiliary/source.json`, exact;
- templates from Word → extract from `word/document.xml`: paragraphs, heading
  level from `w:pStyle`, bold/italic/underline from `w:rPr`, placeholder
  positions.

One renderer, two sources. The UI says plainly when a preview is simplified.
No page breaks, no exact fonts, no images. **Never** use the extractor to
rewrite a Word template — that would lose formatting; editing an imported
template means publishing a new version.

The extractor is the mirror of the OOXML writer the editor needs, so one module
gets `parse` and `build`. Both run server-side, where `node:zlib` is available.

**Placeholder naming.** Flat names, grouped in the UI: `locatario_nome` is shown
as "Locatário › Nome". The grouping is presentation, not structure. The design
system's `{{.locatario.nome}}` would be rejected by the API.

**Status vocabulary.** Only what the server sustains. A generated document is
always "Pronto". "Gerando" is a transient button state. A failure is a message,
not a row. No draft, no archive.

---

## Design system

Source: Claude Design project `18c3a8a6-2f1d-4bfb-9efa-98ff6b796b36`
("Design System Imobiliary Docs"), read via the `DesignSync` tool. Reproduced
here because that access may not survive.

Single **dark** theme — no light mode, no toggle. Figtree + JetBrains Mono.
Spacing base 4px (Tailwind's own scale).

```css
@import "tailwindcss";

@theme {
  --font-sans: "Figtree", ui-sans-serif, system-ui;
  --font-mono: "JetBrains Mono", ui-monospace;

  --color-background: #0b0d10;
  --color-foreground: #e8eaee;
  --color-card: #12151a;
  --color-muted: #191d24;
  --color-muted-foreground: #9aa3b2;
  --color-faint: #828c9b;
  --color-border: #262b34;
  --color-border-strong: #343b47;
  --color-input: #0b0d10;

  --color-primary: oklch(0.74 0.13 195);
  --color-primary-foreground: #06201f;
  --color-docs: oklch(0.78 0.14 85);
  --color-success: oklch(0.74 0.13 150);
  --color-destructive: oklch(0.68 0.17 25);
  --color-ring: oklch(0.74 0.13 195);

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
}
```

Surfaces used by components but missing from that block, promoted to tokens for
consistency: `#0f1216` (sidebar, topbar, table header), `#151920` (row hover),
`#3f4756` (dashed border, hover border), `#525b69` (disabled text).

**Type scale.** display 34/600 `-.025em`; h1 24/600 `-.015em`; h2 18/600;
body 14/1.6; small 13/400; label mono 11 uppercase `.1em`; placeholder token
mono 13 in `--color-docs`.

**Brand.** Always lowercase `imobiliary docs`. "imobiliary" inherits the text
colour; "docs" uses `--color-docs` and never appears alone.

**Buttons.** sm 28px (12px text, radius 6) · md 38px (13.5px, radius 8) · lg
46px (15px) · icon 38×38. Variants: primary (filled), secondary
(`--color-muted` on `--color-border-strong`), ghost, destructive-soft, disabled,
and a loading state with a spinner.

**Inputs.** 14px on `--color-input`, border `--color-border-strong`, radius 8,
padding 9/12. Focus: border `--color-primary` plus a 3px ring at 18% alpha.
Error: destructive border and message.

**Placeholder chips** carry state by colour: amber `--color-docs` = detected,
green = filled, red = required and missing, neutral = ignored.

**shadcn components to generate** (per the design system itself): `button`,
`input`, `dialog`, `table`, `tabs`, `toast`, `progress`. Only two are bespoke:
the placeholder chip and the dropzone.

`support.js` in that project is the Claude Design canvas runtime, not product
code. Nothing there to port.

---

## Status

_Update this section as work proceeds. It is what a fresh session reads first._

**Last updated:** 2026-09-09

### Done

1. Workspace restructure — API moved to `docgen-api/`, `docs/` freed, pnpm
   workspace at the root. All 47 files moved as git renames. (`b81e60b`)
2. Naming note corrected. (`8e382f7`)
3. `GET /v1/templates/{id}/versions/{version}/file` added to the API, with
   integration tests including the byte-for-byte round trip of an embedded
   part. Spec, collection and reference page updated. (`d3b73ff`)

4. Platform scaffolded in `docs/` — TanStack Start on Vite 8, React 19,
   TypeScript 7 strict, Tailwind 4, shadcn on Base UI. Design tokens wired and
   confirmed rendering in the browser. A placeholder landing page exists at `/`.
   `pnpm build` and `pnpm typecheck` are clean.

### Next step

**The core, in `docs/src/`, in this order:**

1. `domain/` — `User`, `Template`, `TemplateVersion`, `Document`, plus the
   validation rules that mirror the API's (password ≥ 12, placeholder names
   `^[a-z][a-z0-9_]*$`). No framework imports.
2. `application/ports.ts` — the interfaces the use cases consume.
3. `infrastructure/api/` — a typed docgen client. The contract is
   `docgen-api/openapi.yaml`; read it rather than guessing field names.
4. `infrastructure/session/` — the AES-GCM cookie.
5. `server/` — auth server functions. **Single-flight the refresh**, and
   forward `X-Forwarded-For`.

Start the dev server with `pnpm dev` from the root; the API needs
`pnpm api:dev` alongside it.

### After that

5. Routes and the app shell, semantic HTML, SEO (`noindex` on app routes).
6. Templates and documents: list, upload, preview, generate, download.
7. The docx `parse`/`build` module, then the block editor and live preview.

### Open items

- `go test -race` still unrun (no C compiler here).
- The design system's "mínimo de 8 caracteres" copy contradicts the API's 12.
- The published API reference lives at
  `https://claude.ai/code/artifact/e3eaf9ee-95d7-46a0-bd7f-d596a95345ee`.
  Update it by republishing `docgen-api/docs/api-reference.html` **with that
  URL**, or a second artifact is created instead.
