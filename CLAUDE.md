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
- **A run that gains outer whitespace needs `xml:space="preserve"`.** Word
  silently discards leading and trailing whitespace in a `<w:t>` without it.
  Pulling a split placeholder into one run moves text into the next one, which
  can leave it starting with a space it did not have — and Word then rendered
  "{{.day}} de setembro" as "09de setembro". `redistribute` now rewrites the
  start tag when that happens. The symptom appears **only in Word**: the XML
  looks right, and every reader that ignores `xml:space` shows the space.
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
- **Vite needs `resolve.dedupe: ["react", "react-dom"]`.** There is only one
  React on disk, but dependency pre-bundling still handed out a second module
  instance: every hook failed with "Invalid hook call … more than one copy of
  React". Deduping pins every importer, Base UI included, to one instance. If
  hooks start failing after a dependency change, clear `node_modules/.vite`
  **and restart the dev server** — clearing it under a running server leaves it
  serving 504s for stale modules.
- **Base UI's Button asserts a native `<button>`.** Rendering one as a link
  (`render={<Link />}`) needs `nativeButton={false}`, or it warns at runtime
  about losing button semantics.
- **Never read `event.currentTarget` inside a state updater.** React nulls it
  once the handler returns, so `setValues(c => ({ ...c, [k]: e.currentTarget
  .value }))` throws and takes the page down. Capture the value first. This
  cost a blank screen once.
- Dependencies it pulled in: `@base-ui/react` (the point of `-b base`),
  `class-variance-authority`, `cn`, `lucide-react`, `tw-animate-css`, and
  `shadcn` itself for `shadcn/tailwind.css`. `@fontsource-variable/geist` was
  removed — the design calls for Figtree, loaded from Google Fonts in
  `__root.tsx`.

### Architecture

```
docs/src/
├── domain/          entities and rules; imports nothing else of ours
├── application/     use cases + the ports they consume
├── infrastructure/  api client, session cookie, config, docx parse/build
├── server/          server functions — the only place that reaches the API
├── components/      shadcn output lives in components/ui
└── routes/          file-based routes
```

`pnpm check:layers` enforces this, the counterpart of `go list -deps` on the
API side. It has been proved to fail on a planted violation, so it is a real
check and not one that always passes.

### Verification

```bash
cd docs && pnpm check   # typecheck + layer rule + tests
```

Tests run on Node's own runner over the TypeScript directly — no Vitest, no
Jest, no test dependency at all. Note `node --test` needs a glob:
`node --test "src/**/*.test.ts"`. Passing a bare directory fails.

Layer imports use explicit `.ts` extensions so Node can run them unbundled;
`allowImportingTsExtensions` is on for that reason. Components and routes may
keep using the `@/` alias.

### Decisions and why

**BFF, not a browser client.** Access and refresh tokens live in one httpOnly,
`SameSite=Lax` cookie, sealed with the framework's own `useSession` from
`@tanstack/react-start/server` — it encrypts and signs the contents, so the
hand-rolled AES-GCM the plan called for was dropped as redundant. Page
JavaScript never sees a token, so an XSS cannot steal a session. `Secure` is on
only in production, since the dev server speaks plain HTTP and the browser
would otherwise refuse to store the cookie at all.

Other framework primitives worth not reinventing:
`getRequestIP({ xForwardedFor })`, `getCookie`/`setCookie`/`deleteCookie`,
`getRequestHost`, `getRequestHeader` — all from the same entry point.

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
function. Note that Start also exports `createCsrfMiddleware`,
`isCsrfRequestAllowed` and `getCsrfRequestValidationResult` — worth evaluating
against the hand-rolled `assertSameOrigin`, which stays for now because it is
explicit and its behaviour is known.

**Binary crosses a server function intact.** Returning a `Uint8Array` uses
Start's binary frame — no base64 and none of the third it would add. Verified:
the downloaded document arrives with the ZIP magic `50 4b 03 04` and opens.

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

**Last updated:** 2026-09-09 — live preview done; the editor is what remains

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

5. Core written and green: 37 tests, typecheck clean, layer rule holding.
   - `domain/` — entities, errors, and the rules mirroring the API's.
     `placeholder.ts` holds the grouping rule that answers the design's
     `{{.locatario.nome}}` without touching the API: a prefix becomes a group
     only when **two or more** names share it, so `valor_aluguel` alone stays
     one field instead of a fake hierarchy.
   - `application/` — the ports, plus `SessionManager` and
     `RefreshCoordinator`. The coordinator is the security-critical piece and
     is covered: two concurrent calls with an expired token exchange the
     refresh secret exactly once.
   - `infrastructure/` — `transport.ts` (HTTP, and the one place a status
     becomes a domain error), `docgen-client.ts` (three gateways over one
     transport), `config.ts`, `session/cookie-session-store.ts`.
   - `server/` — `runtime.ts` is the composition root and holds the
     process-wide `RefreshCoordinator`, the `Origin` check, and the client-IP
     forwarding; `auth.ts` has register, login, logout and currentUser.

6. Auth screens, the app shell and the guard, verified end to end against a
   running API: register → 201, login → 200, templates → 200, logout → 204,
   and a signed-out visit to `/templates` redirects to `/entrar`.
   - Routes: `/` (landing), `/entrar`, `/criar-conta`, and the pathless `_app`
     layout holding `/templates` and `/documentos`.
   - `application/result.ts` — expected failures are **returned**, not thrown.
     A thrown error crosses the RPC boundary as plain data, so the class is
     gone by the time the browser sees it and `instanceof` would always be
     false. Server functions answer `Result<T>`.
   - `components/ui/input.tsx` and `label.tsx` were edited away from the
     shadcn defaults to the design's field: 38px tall, 8px radius, solid
     `--color-input`. Editing generated components is the point of shadcn.

7. Template upload, verified end to end with a fixture whose placeholder is
   split across three runs: the API reassembled it, and the grouping rule held
   on real data — `imovel_*` and `locatario_*` grouped, while `data_inicio`
   and `valor_aluguel` correctly stayed loose rather than inventing
   one-member hierarchies.
   - `/templates/novo`, `createTemplate` taking FormData straight through, and
     the two bespoke components: `dropzone.tsx` and `placeholder-chips.tsx`.
   - The button's default size now matches the design (38px, 8px radius,
     13.5px semibold). Every caller had been overriding it, which is how you
     know a default is wrong. **Base UI uses a `render` prop, not Radix's
     `asChild`** — that is how a Button becomes a Link.

8. **The core loop is closed.** Upload → discover schema → fill → generate →
   download, verified end to end in the browser against a running API.
   - `/templates/$templateId` builds its form from the version's placeholders,
     grouped, with a live "n de m preenchidos" counter.
   - The generated document was opened and read: values substituted, an
     accent survived as UTF-8, and `Acme & Filhos <Ltda>` came out as
     `&amp;` / `&lt;` / `&gt;`. Without that escaping Word refuses the file.

9. **The documents table** names the template behind each row, links to it and
   downloads again. The join happens in the server function — the API returns
   only an identifier, and an identifier tells a person nothing.

10. **The live preview — direction 1b, done.** `/templates/$templateId` shows
    the document with each placeholder editable where it sits.
    - `infrastructure/docx/zip.ts` — a ZIP reader *and* writer over
      `node:zlib`, no dependency. The writer already exists because the editor
      will need it, and because it makes the reader testable by round trip.
    - `infrastructure/docx/parse.ts` — WordprocessingML → blocks.
    - `domain/block.ts` — the block model lives in the domain, because three
      places share it: the reader, the preview, and the writer to come. The
      layer check caught the first attempt, which had the component importing
      it from `infrastructure`.
    - The preview degrades rather than breaks: a document this reader cannot
      make sense of falls back to the plain grouped form, and generation is
      unaffected either way because the API renders from the original archive.

### Next step

Nothing is half-finished; pick up whichever the user asks for.

- **The block editor**, the last piece of the original plan. It needs the docx
  `build` module: blocks → `word/document.xml` → `writeZip`. Write the writer
  and **open its output in Word before building any interface around it** —
  that is the step that decides whether the whole idea works. Store the block
  tree as `imobiliary/source.json` inside the archive so the template can be
  reopened; the API preserves unknown parts byte for byte, which is proven by
  a test on its side.
- Smaller, real gaps: no delete in the interface, and no way to publish a new
  version of an existing template.

Add components with `shadcn add dialog table tabs toast progress` as screens
need them — **never `shadcn init` again**, which would overwrite the theme.

### After that

7. The template detail screen, then generation and download.
8. The docx `parse`/`build` module, then the block editor and the live preview.

### Running it

```bash
pnpm api:dev    # the Go API on :8080
pnpm dev        # the platform on :3000
```

`docs/.env` needs `SESSION_SECRET` (32+ chars) or the platform refuses to
start. `DOCGEN_API_URL` defaults to `http://localhost:8080`.

### Open items

- **`X-Forwarded-For` forwarding is written but never verified.** The API's
  access log records method, path and status but not the client address, so
  there is no way to confirm from the outside that the real IP arrives. Adding
  the address to that log line would be worth doing on its own — an API whose
  rate limit is per-IP should say which IP it charged.
- The browser automation's synthetic clicks do not reach Base UI's button: a
  `left_click` on it fires no `click` event at all, while `form.requestSubmit()`
  runs the same handler correctly. Drive forms that way when verifying; it is a
  harness artifact, not a product bug.
- `go test -race` still unrun (no C compiler here).
- The design system's "mínimo de 8 caracteres" copy contradicts the API's 12.
- The published API reference lives at
  `https://claude.ai/code/artifact/e3eaf9ee-95d7-46a0-bd7f-d596a95345ee`.
  Update it by republishing `docgen-api/docs/api-reference.html` **with that
  URL**, or a second artifact is created instead.
