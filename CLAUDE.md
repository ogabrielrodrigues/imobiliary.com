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
  `shadcn` itself for `shadcn/tailwind.css`.
- **The fonts are self-hosted**, via `@fontsource-variable/figtree` and
  `@fontsource-variable/jetbrains-mono`, imported in `src/styles/app.css`. They
  were on Google Fonts until the LGPD pass: that sent every visitor's address to
  a third party and was the only external host the browser touched. Putting one
  back would break `default-src 'self'` in the CSP and reopen the
  international-transfer section of the privacy policy.

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

**Last updated:** 2026-09-10 — SEO discovery layer done; the editor is what remains

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

11. **The app shell holds one viewport.** It was `min-h-dvh` — a minimum — so a
    long page stretched the row and the sidebar with it, pushing the account
    block below the fold. `PageBody` is now the scroll container, which pins the
    header for free. **`min-h-0` on `PageBody` is the load-bearing line:** a
    `flex-1` item in a column has a vertical main axis, so its default
    `min-height: auto` refuses to shrink below its content and `overflow-y-auto`
    never engages. `scrollRestoration: true` is now a silent no-op — it restores
    *window* scroll, which no longer moves.

12. **The template lifecycle is complete.** Versioning and deletion, both
    verified end to end in the browser: published a v2 with a different schema,
    switched back to v1, generated from v1 (the card reported "versão 1", not
    the latest), deleted the template, and found the document still listed and
    downloadable.
    - `GET /v1/templates/{id}/versions` added to the API. **It fetches the
      template first**, so an unknown or foreign id answers 404 rather than an
      empty list, matching `Get`.
    - `DELETE` moved from the `read` middleware to `write`. It was the only
      mutation not charged to the per-account limiter.
    - The version rides in the URL as `?versao=N`. **`loaderDeps` is what makes
      the loader re-run** on that change; without it the router treats it as the
      same match and serves the cache.
    - `getTemplateContent` returns the template with `version` **replaced by the
      chosen one**, so every reader downstream keeps asking for
      `template.version` and gets the schema that applies.
    - The screen is keyed on the version. Switching re-runs the loader without
      unmounting, so values typed against the old schema would otherwise survive
      into a form that no longer shows those fields, and the API would reject
      keys the user cannot see.

13. **The wordmark leads home, and the landing page sees the session.** Two
    reported defects, one root: nothing outside `_app` knew whether a session
    existed.
    - `Brand` takes an optional destination and renders a router `Link`.
      **The landing page had a private duplicate of it** shadowing the shared
      component — which is why the mark there had drifted to a fixed 18px.
      Deleted; if a wordmark ever looks wrong on one screen only, check for
      another copy before editing the shared one.
    - `/` loads `currentUser` and swaps its calls to action. A **loader**, not
      a `beforeLoad`: no redirect to decide, only a fact to render. The pitch
      itself is unchanged — only the calls to action had to know.
    - `/entrar` and `/criar-conta` mirror the `_app` guard, inverted. No loop:
      both sides read the same cookie and cannot disagree.
    - `currentUser` reads **only the cookie**, so a cookie whose tokens are
      already dead now bounces someone to a screen that fails. `LoadFailure`
      offers a way back to sign-in on an authentication failure, which turns
      that dead end into a step.

14. **LGPD adequacy.** The survey behind it is `docgen-api/PRIVACIDADE.md`, the
    article 37 record — it lists the gaps as plainly as the measures. Read it
    before touching anything that stores data.
    - **Roles:** controller of the account, **processor** of the document
      contents. A tenant asking about a contract is referred to the broker; the
      terms carry the article 39 clause that makes that real.
    - **Erasure is real.** `DELETE /v1/me` fires the cascades — which nothing
      had ever fired — and removes the stored files, counting references first
      because content addressing means one file can belong to several accounts.
      Rows go before files: a crash in between leaks a file rather than breaking
      a record.
    - **The export includes soft-deleted templates**, marked as such. An access
      request asks what is held, not what is shown.
    - **Deleting a template is still an `UPDATE`.** Never call that erasure in
      any text; the policy is careful about it and so should you be.
    - Fonts are served locally. That removed the last external host, and it is
      what lets the CSP say `default-src 'self'`. Reintroducing a CDN means
      reopening the international-transfer section of the policy.
    - The controller identity lives in `docs/src/domain/legal.ts` and is **still
      placeholders**. Production refuses to boot while any remain; the test
      suite deliberately does not fail on them.

15. **Password change and recovery.** There was no way to do either, so
    losing a password meant losing the account.
    - **Changing one ends every other session immediately.** Revoking was
      not enough on its own: an access token is stateless and `Authenticate`
      never read the session table, so a revoked session kept working for up
      to fifteen minutes. Tokens now carry their issue time and are compared
      against `users.password_changed_at`.
    - **That comparison is truncated to the second**, because a JWT issue
      time carries nothing finer. Without the truncation the replacement
      token rejects itself. The residue is a one-second window, and the
      integration test crosses a second boundary on purpose — if it ever
      looks like a flaky sleep, read the comment before deleting it.
    - The recovery endpoint always answers 202 and logs its own failures,
      so it cannot become a directory of who has an account here.
    - **Mail goes through Resend behind a `Mailer` port**, written against
      the HTTP API rather than the SDK, so the module still has three
      dependencies. **With no key configured it logs instead of sending** —
      that is the default, and it is how the reset link reaches the terminal
      in development.
    - Resend is now a declared processor and an international transfer in the
      privacy policy (bumped to 1.1). A DPA with them is an open item.

16. **SEO, the discovery half.** The semantic half was already right; none of
    the rest existed.
    - `robots.txt` and `sitemap.xml` are **route handlers**, not files in
      `public/`. The API is `server: { handlers: { GET } }` on an ordinary
      file route, and the filename escapes the dot: `robots[.]txt.ts`.
      `createServerFileRoute` does **not** exist in this version.
    - **A route with a `server` handler must not have a `component`.** With
      one, the handler is allowed to defer and a missing return falls
      through to SSR instead of erroring.
    - Tags are built once in `src/lib/seo.ts`. Adding a public route means
      calling `pageSeo` — writing the meta by hand is how a page ends up
      without a canonical.
    - `SITE_URL` is a build-time constant (`VITE_SITE_URL`), not server
      config: canonical and Open Graph have to reach the browser.
    - **No `og:image` on purpose.** A card without one still renders; one
      pointing at a missing file shows a broken frame. Needs a 1200×630 PNG.
    - The JSON-LD omits `publisher` while the controller identity is still
      placeholders, so no `[RAZÃO SOCIAL]` can reach a search engine.

### Next step

**The block editor**, the last piece of the original plan. It needs the docx
`build` module: blocks → `word/document.xml` → `writeZip`. Write the writer and
**open its output in Word before building any interface around it** — that is
the step that decides whether the whole idea works. Store the block tree as
`imobiliary/source.json` inside the archive so the template can be reopened; the
API preserves unknown parts byte for byte, which is proven by a test on its
side.

Deferred deliberately, for a later conversation: **batch generation from a
`.csv`**, mainly exports from Google Forms.

Add components with `shadcn add table tabs toast progress` as screens need them
— **never `shadcn init` again**, which would overwrite the theme.

### Adding a shadcn component, in practice

`shadcn add <name>` **prompts to overwrite `button.tsx`** and ignores `-y` for
that question, so it blocks in a non-interactive shell. Pipe refusals into it —
`printf 'n\nn\n' | pnpm dlx shadcn@latest add <name>` — and never accept: that
file is tuned to the design. `-b base` is an `init` flag only; `add` reads the
`base-nova` style already recorded in `components.json`.

A new Base UI subpath makes Vite re-optimise dependencies, which can leave the
open page holding modules from two generations and failing every hook. Stop the
dev server, delete `node_modules/.vite`, start it again — in that order.

**Base UI dialogs cannot be server-rendered here.** Mount one only once it has
been asked for; a modal has nothing to show on the server, and rendering its
root during hydration fails the whole route into the error boundary.

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
- **`summaryOf` in `application/result.ts` speaks only about authentication.**
  A 401 after a failed refresh renders "E-mail ou senha incorretos." wherever
  it happens — including inside the delete dialog. The copy needs a context,
  or the auth screens need to override those two strings locally.
- `GET /v1/templates/{id}/versions` is paged and the platform asks for 100.
  A template with more versions than that would silently lose the oldest from
  the picker. Nothing shows that it truncated.
- **`docs` cannot be started from a production build.** `pnpm start` runs
  `node .output/server/index.mjs`, a Nitro-era path that no longer exists —
  `vite build` produces `dist/client` and `dist/server`. Running
  `dist/server/server.js` directly with `PORT` set produces no output and
  never listens, so it likely needs a host adapter that is not installed.
  **Nothing has ever been deployed from this repository.** Resolve before
  planning a launch; it is a deployment question, not a code bug to guess at.
- **An Open Graph image is missing** — 1200×630 PNG, the one SEO item that
  is design work rather than code. Add it to `public/` and give `pageSeo` an
  `og:image`/`twitter:image` pair pointing at it.
- **No DPA with Resend yet.** They receive an email address and a first name
  when a security message goes out, which is a declared international
  transfer. Sign the processing contract, under the ANPD standard clauses,
  before operating with real data.
- **The legal texts need a lawyer.** They were written from the code and are
  accurate about it, but accuracy is not legal sufficiency.
- **`docgen-api/data/docgen.db` holds real personal data in the clear** — a CPF,
  and the owner's own name and city, left from testing. Nothing is encrypted at
  rest. Discard that database before anything is published.
- **The API terminates no TLS**; it serves plain HTTP. The privacy policy now
  promises encryption in transit, so a TLS-terminating proxy is a **deployment
  requirement**, not an option — and the API must be unreachable from outside
  whenever `DOCGEN_TRUST_PROXY_HEADERS=true`.
- Deferred deliberately: encryption at rest for `documents.data` and the blobs,
  automatic retention and purge, a sweeper for blobs orphaned by a crash
  mid-erasure, and a written incident-response process (art. 48).
- **`/` now varies per visitor.** It reads the session cookie, so it can no
  longer be served from a shared cache without varying on that cookie. A
  crawler arrives anonymous and still gets the HTML it always got, so search
  is unaffected — but this matters the day a CDN goes in front of it.
- `docgen-api/docs/api-reference.html` changed when the versions endpoint was
  added, and the published artifact below still carries the older text.
- The published API reference lives at
  `https://claude.ai/code/artifact/e3eaf9ee-95d7-46a0-bd7f-d596a95345ee`.
  Update it by republishing `docgen-api/docs/api-reference.html` **with that
  URL**, or a second artifact is created instead.
