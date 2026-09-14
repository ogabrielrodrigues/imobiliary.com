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

`go test -race` first ran on 2026-09-14, unit and integration, with no race
reported. It needs cgo, so a C compiler: the WinLibs GCC was installed with
winget for it and is not on the shell's PATH by default. In PowerShell:

```powershell
$env:PATH = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin;$env:PATH"
$env:CGO_ENABLED = "1"
go test -race ./... ; go test -race -tags=integration ./...
```

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
  or it blocks forever in a non-interactive shell. (That preset chose Lucide;
  the project has since moved to Tabler — see below.)
- **`shadcn init` appends its own palette and overrides the theme.** It wrote a
  light `:root`, a `.dark` block, and an `@theme inline` that replaced the font
  with Geist and the colours with greys. `src/styles/app.css` has since been
  rewritten by hand: the design palette lives once in `:root`, `@theme inline`
  maps it onto Tailwind's colour utilities, and the `dark:` variants shadcn's
  components are written with resolve through `@custom-variant dark`, which
  matches any page not in a light `data-scheme` (there is no `dark` class since
  the themes, item 20). **Re-running
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
- **Icons are Tabler** (`@tabler/icons-react`), at the user's request: it is
  an icon library shadcn supports officially. `components.json` says
  `"iconLibrary": "tabler"` so `shadcn add` generates with it; `lucide-react`
  was removed. A generated component that still imports Lucide gets converted.
  Decorative icons carry `aria-hidden`; an icon-only button keeps its
  `aria-label`.
- **Type sizes are rem tokens and `cn` is `@/lib/utils`.** See item 18 of
  the Status; both have bitten once.
- Dependencies it pulled in: `@base-ui/react` (the point of `-b base`),
  `class-variance-authority`, `cn`, `tw-animate-css`, and
  `shadcn` itself for `shadcn/tailwind.css`.
- **A Fontsource variable package registers "<Name> Variable"**, not the
  plain name. `--font-sans` said "Figtree" until 2026-09-11, which matched no
  loaded face, so the platform rendered in the system font the whole time;
  `document.fonts` showed zero loaded faces. Always put the "… Variable"
  name first, and check `document.fonts` after changing a font.
- **The fonts are self-hosted**, via `@fontsource-variable/fustat` and
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

Three themes since 2026-09-11: **Escuro** (the default, reproduced below),
**Claro** and **Papel** (`... -claro-.dc.html`, `... -papel-.dc.html` in the
same project). Their values live in `docs/src/styles/app.css`, one block per
`data-scheme`. **The token block at the end of both light files is out of
date** — it repeats the dark accents; the swatches and components are right.
Four places where the light designs fail WCAG AA were changed on purpose, and
the Claude Design project should take the same values: text in the primary hue
(`--primary-text`, the design's dark hover amber), the focus ring (same
value), field borders (`#87837c` / `#887d68`, 3:1), and text on a
destructive or success tint (`--destructive-soft` / `--success-soft`, which
the design already draws). **Fustat** + JetBrains Mono: the design says
Figtree, and Fustat replaced it at the user's request (2026-09-11) in a commit
of its own, so reverting that commit alone restores Figtree.
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

  --color-primary: oklch(0.8 0.15 82);
  --color-primary-foreground: #231404;
  --color-docs: oklch(0.66 0.12 58);
  --color-success: oklch(0.74 0.13 150);
  --color-destructive: oklch(0.68 0.17 25);
  --color-ring: oklch(0.8 0.15 82);

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
}
```

Text on a docs tint (placeholder chips, pills, warnings) is drawn lighter than
`--docs` itself: `--docs-soft`, `oklch(0.82 0.1 68)`.

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

**Last updated:** 2026-09-11 — TanStack Query, Table and Form done; the editor is what remains

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

17. **Security sweep, and every finding fixed.** Plan and evidence in the
    plan file's security section. Verified clean: `pnpm audit`, `govulncheck`
    (GO-2026-5932 in x/crypto is not reachable and has no fix — watch it), zip
    slip, template injection, SQL, JWT, XSS, ReDoS, secrets never committed.
    Fixed, one commit each group:
    - **Mail fails closed** (`d3132b0`). No Resend key → the API refuses to
      start, unless `DOCGEN_MAIL_LOG=true` is declared. The old silent
      fallback logged reset links, which is account takeover for anyone
      reading logs.
    - **Register no longer reveals taken emails** (`dd58230`). Always 202, no
      body; a taken address gets an "someone tried to sign up" email instead.
      The hash runs on both paths so timing matches.
    - **Cookie expires with the refresh token, API binds to 127.0.0.1, a
      global argon2 semaphore (8)** (`9be5c5b`).
    - **Platform zip reader capped at 16 MiB per entry, `TRUSTED_ORIGIN`,
      no decoder echo in 422s, `no-store` on every server function, account
      export is a POST with the origin check** (`49effdf`).
    - **Rate limit keys IPv6 per /64** — per-address keys let one client
      rotate through its /64 past the login limit — **and the bucket map is
      swept early past 100k keys** (`d114363`).
    - `pnpm security` at the root (`scripts/security.mjs`, pinned tool
      versions) runs all of it; proven to fail on a planted `minimist@1.2.0`.
      Use `npx`, not `pnpm dlx`, for Redocly: dlx cannot pick between its two
      binaries and writes to `pnpm-workspace.yaml` as a side effect.
    - `SECURITY.md`, `/.well-known/security.txt` (contact from
      `CONTROLLER`; bump `REVIEWED` yearly or `Expires` lapses), and a
      deployment section in the root README.

18. **Accessibility, and the Ajustes page.** Plan in the plan file's
    "Acessibilidade e a página de Ajustes" section.
    - **The type scale is in rem** (`--text-micro` … `--text-display` in
      `app.css`, each equal to the design's px at 16px). 78 px sizes were
      converted; at 100% the computed styles of the public pages hash
      identically before and after. **Never write `text-[Npx]` again** — a px
      size ignores both the browser's font setting and the preference.
    - **`cn` comes from `@/lib/utils`, never from `"cn"`.** It is created
      with the scale in its font-size group; the stock one read `text-small`
      as a colour and silently dropped it next to `text-foreground` — every
      field label lost its size. `utils.test.ts` fails if a token is added to
      the stylesheet but not to `FONT_SIZES`. **A shadcn component added later
      imports `"cn"` and must be repointed**, as `tabs.tsx` was.
    - **Contrast is tested** by `styles/contrast.test.ts`, which reads
      `app.css` itself: AA for the default theme, AAA (7:1) for high contrast,
      3:1 for field borders and the ring, and accents over their own 15% tint.
      The audit that preceded it used an OKLCH conversion without the sRGB
      transfer function and reported four accent failures that did not exist;
      a commit lightened them before the error was caught, and the next one
      (`5b1826f`) restored the design's values. Only two failures were real:
      the destructive button's 20% tint (now 12%) and field borders
      (`--input-border`, 3.7:1). **The Claude Design project should get those
      two changes.**
    - **Preferences** (text size, contrast, motion) live in localStorage under
      `imobiliary_docs_accessibility`, parsed field by field. A script in the
      head, emitted with the router's `ScriptOnce` (which removes itself and
      already carries the SSR nonce), applies them as `data-*` on `<html>`
      before first paint; `<html>` has `suppressHydrationWarning` for that.
      A test runs the script in a `vm` sandbox against the parser's cases.
    - **`/ajustes`** has shadcn Tabs (Acessibilidade / Segurança / Meus dados)
      with the tab in `?aba=`, switched with `replace`. The panels live in
      `components/settings/`. `/meus-dados` redirects to `?aba=dados`. The
      sidebar entry, with the gear icon, sits in its own "Conta" nav.
    - **Screen readers:** a skip link, `<main id="conteudo" tabIndex={-1}>` on
      every layout (`PageBody` is the app's), and `RouteAnnouncer`, which on
      a change of *path* announces the title and moves focus to `<main>` —
      unless focus is already inside it, because the auth forms autofocus
      their first field. It uses a timer, not `requestAnimationFrame`: frames
      do not run in a background tab. The required chip says "obrigatório"
      in its label and has a dashed edge and a "!", not colour alone.
    - Privacy policy 1.2: section 5 lists the second local-storage record.
    - **The controls, at the user's request:** text size is a 4-step shadcn
      **Slider** (an ordinal scale), applied on release — resizing the page
      mid-drag moves the slider out from under the pointer. Contrast and motion
      are **Switches**, because they are on/off: contrast has a "Seguir o
      sistema" checkbox beside it (three stored states, two controls; while
      the system decides, the switch is disabled and shows what the system is
      asking for), and motion is one switch whose off state still honours the
      system.
    - **shadcn wrappers adjusted:** `slider.tsx` takes `thumbProps` (Base UI
      puts `getAriaLabel`/`getAriaValueText` on the thumb) and must get
      `value` as an **array** — a scalar renders two thumbs. `switch.tsx` is
      in rem and its unchecked track uses `--input-border`; the stock one was
      about 1.1:1 on a card.

19. **The palette changed in Claude Design** (2026-09-11): primary is amber
    `oklch(0.8 0.15 82)` with `#231404` on it, replacing the teal; `docs` is
    a darker amber, `oklch(0.66 0.12 58)`; text on a docs tint uses the new
    `--docs-soft`. Surfaces, text, success and destructive are unchanged.
    High contrast moved to amber as well (`0.88 0.13 82`, docs `0.86 0.11 62`).
    Every pair passes the contrast test; the favicon's "d" is now `#c87e41`.

20. **Themes: Escuro, Claro, Papel, and Seguir o sistema.** Plan in the plan
    file's "Temas" section.
    - **The system is resolved in JavaScript, not in CSS.**
      `resolveAppearance` (`domain/accessibility.ts`) turns the stored
      preferences plus what the system asks for into `data-scheme`,
      `data-contrast` and `data-motion` on `<html>`; the head script repeats
      it in miniature (tested against it in a `vm` sandbox across every
      system combination) and `AppearanceSync` re-applies on a media-query
      change or a `storage` event from another tab. The stylesheet only ever
      sees concrete values, which is what removed the duplicated
      "high contrast by the system" blocks.
    - **There is no `dark` class any more.** `@custom-variant dark` matches
      any page not in a light scheme, so shadcn's `dark:` variants keep
      working with nothing to keep in sync.
    - **Theme selectors are not tied to `:root`**, so any element with
      `data-scheme` draws with that theme; the Aparência tab's previews are
      real themes, not copied colours.
    - New tokens: `--primary-text` (text in the primary hue; `text-primary`
      is gone from the code), `--success-soft`, `--destructive-soft`.
      **Never set text in `text-primary`** — in the light themes it is 1.8:1.
    - High contrast keeps the reader's lightness: black in Escuro, white in
      Claro and Papel. The contrast test covers five palettes.
    - Ajustes gains **Aparência** as its first and default tab. Restoring the
      accessibility defaults leaves the theme alone.
    - Privacy policy 1.3: the local-storage record now names the theme.
    - **Verification limit:** this harness's colour-scheme emulation fires no
      `change` event (a page-level listener counted zero), so switching the
      system with the page open could not be shown here; the cross-tab
      `storage` path through the same code was.

21. **Fustat instead of Figtree**, in its own commit so it can be reverted
    alone. Just before it, a separate fix: the stylesheet had asked for
    "Figtree", but the Fontsource package registers "Figtree Variable", so no
    face ever loaded and the platform rendered in the system font; the same
    was true of JetBrains Mono. Both names are now the "… Variable" ones, and
    the browser lists the faces as loaded.

22. **Responsive layout.** Below `md` the sidebar becomes a drawer (shadcn
    `sheet` over Base UI's dialog, mounted only once opened, closed on any
    navigation) behind a top bar with a menu button; `SidebarContent` is
    shared by both. `PageHeader` wraps its actions, `PageBody` pads `p-4`,
    Documentos shows cards instead of the table, Ajustes' tabs scroll
    sideways, the landing title drops to `headline`, dialogs keep a 1rem
    margin, and icon-only buttons are 40px on a phone.
    - **Desktop is unchanged, and proven:** at 1280px the computed-style hash
      of every public page matches the one taken before the change. Every new
      class either applies below `md` only or resolves to the old value on a
      wide screen.
    - At 375px and 320px no public page scrolls sideways.
    - **`CI=true` breaks `shadcn add`:** it stops the CLI answering "no" to
      the overwrite prompt and the add fails. Use it only for `pnpm install`.
    - The signed-in screens (drawer, cards) still need a signed-in browser to
      be seen.

23. **The dashboard, at `/dashboard`, now the home after sign-in.** The brand
    in the app, the sign-in and sign-up redirects and the landing page's
    calls to action all lead there; it is first in the sidebar.
    - **API: `GET /v1/me/stats?days=7|30|90&tz=<IANA>`** (`40215aa`). Days
      are bucketed in Go in the caller's zone (`time/tzdata` embedded — Windows
      has no zone database); totals and the top five are SQL. Comparing
      `created_at` as text in SQL is sound only because the stored layout is
      fixed-width UTC. A deleted template still ranks, marked `deleted`.
    - **Platform:** `getDashboard` fetches the stats, the five latest documents
      and the template names in parallel. The window is `?periodo=` in the
      URL. **The first load renders on the server, which cannot know the
      viewer's zone: it uses `America/Sao_Paulo`** (`DEFAULT_TIME_ZONE`);
      client navigations use the browser's.
    - **Charts:** shadcn Chart (Recharts 3.8). `chart.tsx` was adjusted: the
      series colours go through the container's `style` prop instead of a
      `<style>` written with `dangerouslySetInnerHTML`, and its light/dark map
      is gone because tokens already follow `data-scheme`. The series uses
      `--primary-text`, already held above 3:1 by the contrast test, so no
      `--chart-*` tokens were needed. Animation stops under
      `data-motion="reduce"` (`useReducedMotion`). A summary sentence gives
      the chart's facts in text.
    - **The template ranking is a list with bars, not a chart**, so each row
      can be a real link. The shadcn `card` that came with `chart` was
      removed, unused.
    - An account with no documents gets three getting-started steps instead
      of empty charts.

24. **TanStack Query, Table and Form** (`cb41b3f`, `4ede01c`, `5693641`). Versions pinned: react-query 5.102.8,
    react-router-ssr-query 1.167.2, react-table 9.2.4, react-form 1.33.5.
    - **Query.** One `QueryClient` per router, created in `getRouter`, never
      at module level: on the server a shared client would hand one account's
      cache to the next request. `setupRouterSsrQueryIntegration` dehydrates
      what the server fetched. Loaders call `ensureQueryData`, components
      `useSuspenseQuery`; the data is still the `Result<T>`. Factories live
      in `src/queries/` (a layer of its own in `check-layers.mjs`); keys and
      **what each change makes stale** are in `queries/keys.ts`, tested.
      `staleTime` 30s, `retry: false` (expected failures are values),
      `defaultPreloadStaleTime: 0` so the router always asks and the query
      cache decides. Sign-in, sign-out and account deletion `clear()` it.
    - **The dashboard's loader returns the zone it used**, and the component
      builds its key from that. Recomputing the zone in the component gives
      the server's default on the server and the browser's zone on hydration:
      two keys, and everything fetched twice.
    - **The guards still call `currentUser` directly**, not through a query:
      a guard should read the cookie on every navigation, not a cache.
    - **Table v9 is not v8.** `useTable({ features, columns, data })`, with
      features and row models declared in `tableFeatures(...)`; the v8
      `useReactTable`/`getCoreRowModel` examples on the web are wrong for it.
      The package ships its own docs under `node_modules/@tanstack/*-table/
      skills/` — read those. Documentos pages with `?pagina=` and asks for one
      row more than it shows, since the API returns no total. **No filter by
      template**: the API has none, so a filter could only search the page on
      screen. Sorting says it applies to the page.
    - **Form.** `lib/form.ts` holds the rule, as a custom `validationLogic`
      over one form-level `onDynamic` validator that calls the domain:
      leaving a field validates; while any field shows an error each
      keystroke revalidates; after a submit everything does. `visibleError`
      shows an error only once its field was left or the form submitted.
      **A form-level validator is called without the changed field's name**
      (`FormApi.validateSync` never passes `fieldName`), which is why the
      rule looks at every field's meta; the first version keyed on the name
      and never revalidated. Server errors win on their field and are
      dropped when the person edits. On the generation screen the form owns
      the values; chips bind `data.<placeholder>` fields through
      `DocumentPreview`'s `renderPlaceholder`.
    - Sign-up's terms checkbox was never enforced: `required` does nothing
      under the form's `noValidate`. It is a validated field now.
    - **The TanStack packages are in `optimizeDeps.include`.** Discovered
      mid-session, one re-optimised the dependencies and the open page failed
      every hook. Also, `graphify update` rewrites `graphify-out/graph.html`,
      which makes Vite reload the page — do not run it during a browser test.
    - Verified in the browser, signed out: the blur/keystroke/submit rule on
      Entrar and Esqueci minha senha, sign-up's four errors including the
      terms, no console errors. **The signed-in half is not seen yet**: the
      cache on returning to a screen, generating then seeing Documentos
      update, the table's sorting and paging, the generation form.

25. **The small open items, cleared** (2026-09-14).
    - `inputValidator()` → `validator()` on all fifteen server functions.
    - **A 401 reads as an expired session by default.** `summaryOf(failure,
      overrides)` takes the screen's own sentence: sign-in says "E-mail ou
      senha incorretos.", the reset screen says the link expired, the password
      panel says the current password does not match. The API returns 401 for
      all of these on purpose; only the screen knows which it can mean.
    - **404 page:** `components/not-found.tsx`, set as the router's
      `defaultNotFoundComponent`. Still a real 404 status; it sets its own
      title because no route's head runs.
    - **Version picker:** `getTemplateContent` reports `versionsTruncated`
      when the page of 100 came back full, and the picker says older versions
      are not listed. It still cannot reach them.
    - **Open Graph image:** `public/og-image.png`, from
      `scripts/og-image/og-image.html` (see the README there: render in a
      taller window and crop, or headless Chrome cuts the bottom off).
    - **Claude Design:** a new page, "Imobiliary Docs - Acessibilidade", lists
      every token the platform changed for contrast, per theme, and the content
      corrections (12-character minimum, flat placeholder names, Fustat, no
      draft or error statuses). **The existing design files were not edited**:
      there is no local copy and the tool only replaces whole files, so fixing
      "Mínimo de 8 caracteres" in place means rewriting ~30 KB of hand-authored
      HTML per file. That is the user's call.
      **The user decided (2026-09-14): leave the original design files as they
      are and correct only in the code.** Never rewrite an existing design file.

26. **Document names, and whole listings** (plan: "Nome do documento, listas
    completas, histórico com lotes e geração por CSV", phases 1 and 2).
    - **Naming** (`b4c25e8`): the generation screen has "Nome do documento",
      suggested as `<template> - <value>`; "Completar com" chooses the field
      (default: the first ending in `_nome`), the date, or nothing, remembered
      per template in localStorage `imobiliary_docs_document_name` (privacy
      policy 1.4). Rules in `domain/document-name.ts`. **The API silently
      replaces any character other than letters, digits, space, `.`, `-`, `_`
      with `_` and cuts at 100 bytes**; suggestions are cleaned the same way and
      a typed name that breaks the rule is an error on the field, so what is
      shown is what is stored. Names are displayed without `.docx`.
    - The remembered choice is applied in an effect, not during render: the
      server cannot read localStorage, and reading it in render hydrates a
      different select.
    - **Whole listings** (`d4daaca`): `collectPages`
      (`application/paging.ts`) reads until a short page, capped at 1000 and
      reported as truncated. Used by the template list, the versions of the
      generation screen, and the template-name lookups in Documentos and the
      dashboard. A template pinned beyond its 100th version opens again.
    - Next in that plan: phase 3, batches, a template filter and a history
      endpoint in the API.

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
start. `DOCGEN_API_URL` defaults to `http://127.0.0.1:8080`, where the API
now binds. `docgen-api/.env` needs `DOCGEN_MAIL_LOG=true` in development, or
a Resend key — the API refuses to start with neither.

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
- The design system's "mínimo de 8 caracteres" copy contradicts the API's 12.
  The correction is documented on the "Acessibilidade" page of the Claude
  Design project (item 25); the original files still say 8.
- `GET /v1/templates/{id}/versions` is paged and the platform asks for 100.
  The picker now says when older versions are not listed (item 25), but a
  template with more than 100 still cannot reach them.
- **`docs` cannot be started from a production build.** `pnpm start` runs
  `node .output/server/index.mjs`, a Nitro-era path that no longer exists —
  `vite build` produces `dist/client` and `dist/server`. Running
  `dist/server/server.js` directly with `PORT` set produces no output and
  never listens, so it likely needs a host adapter that is not installed.
  **Nothing has ever been deployed from this repository.** Resolve before
  planning a launch; it is a deployment question, not a code bug to guess at.
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
- **`'unsafe-inline'` is still in the CSP `script-src`.** Removing it needs a
  per-request nonce threaded through the framework's own script tags.
  Mitigated by the framework escaping its inline state and by the absence of
  any raw-HTML sink, but it is the one hardening item the sweep left open.
- **No CI.** `pnpm security` is run by hand. It was written to be called by a
  CI job unchanged, the day there is one.
- **The signed-in screens of the accessibility work are not yet verified in a
  browser**: `/ajustes` and its tabs, the sidebar entry, the `/meus-dados`
  redirect, the required-chip label and `<main>` inside the app. The
  verifying session had no signed-in browser, and signing in is the user's to
  do. Everything public was verified, and the code typechecks and is tested.
- Accessibility, deliberately out of scope for now: underlined links outside
  high contrast, and text spacing. (Reflow at 320px, WCAG 1.4.10, was closed
  by the responsive layout, item 22.)
- The accessibility head script is inline too, so it joins the CSP nonce
  item above; `ScriptOnce` already passes the router's nonce through.
- **The Aparência tab and the themes inside the app are not yet seen in a
  browser signed in**, like the rest of Ajustes. Public pages were verified
  in all three themes and both high contrasts.
- The favicon's "d" is the Fustat glyph at weight 600 since 2026-09-14,
  extracted with `fonttools` (installed for the user with pip, with `brotli`
  for WOFF2) by instancing the Fontsource variable font at wght=600. If the
  font changes again, the same route applies: instance, draw the glyph with
  `SVGPathPen`, scale to 20px and centre the bounding box.
- The published API reference (republished 2026-09-11, with `/v1/me/stats`,
  the versions endpoint and registration's 202) lives at
  `https://claude.ai/code/artifact/e3eaf9ee-95d7-46a0-bd7f-d596a95345ee`.
  Update it by republishing `docgen-api/docs/api-reference.html` **with that
  URL**, or a second artifact is created instead.
