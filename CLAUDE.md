# CLAUDE.md

Working notes for this repository. Read this first — it carries the decisions
and the current position, so a fresh session can pick up without re-deriving
anything.

**Keep the "Status" section at the bottom current.** It is the handover.

---

## What this is

**Imobiliary** — property management for independent brokers, small agencies
and owners. This repository holds the document half, finished, and the main
platform, being built:

| Directory | What | Runs at |
|---|---|---|
| `docgen-api/` | DOCX rendering API, Go | a private subdomain |
| `docs/` | document platform, TypeScript | `docs.imobiliary.com` |
| `imobiliary-api/` | rental management API, Go + PostgreSQL | a private subdomain |
| `web/` | rental management platform, TypeScript | `imobiliary.com` |
| `packages/ui/` | design tokens, themes, accessibility, shared by both platforms | — |
| `packages/docx/` | the .docx reader and writer, the block model and the preview | — |
| `modelos/` | marked copies of real models, for end-to-end tests | — |

**The main platform follows `PLANO.md`** (in Portuguese, decided with the user
over five rounds on 2026-09-15). Read it before touching `imobiliary-api/`,
`web/` or `packages/ui/`: identity, tenancy, the data model and the legal rules
are settled there and must not be re-derived. Its section "Imobiliary (main
platform)" below carries what was learned while building it.

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

## Imobiliary (main platform)

Phases in `PLANO.md` §7. Root scripts are prefixed by project (`docgen:*`,
`docs:*`, `imobiliary:*`, `web:*`).

Platform copy (every text a user reads) avoids AI writing tics: no em dash, no
habitual triplets, nothing the system does not actually do. The user asked for
this explicitly.

Inputs carry a placeholder whenever it helps (user's request, 2026-09-16):
the expected shape (`000.000.000-00`, `(00) 00000-0000`, `nome@exemplo.com`)
or a short cue. It complements the label, never replaces it; password fields
and native date pickers go without.

---

## Design system

Source: Claude Design project `18c3a8a6-2f1d-4bfb-9efa-98ff6b796b36`
("Design System Imobiliary Docs"), read via the `DesignSync` tool. Reproduced
here because that access may not survive.

Three themes since 2026-09-11: **Escuro** (the default, reproduced below),
**Claro** and **Papel** (`... -claro-.dc.html`, `... -papel-.dc.html` in the
same project). Their values live in `packages/ui/src/tokens.css`, one block per
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

**Last updated:** 2026-09-21: phase 8 complete, so every phase of `PLANO.md` is done; phase 7 complete (the docgen integration: identity moved to the platform, documents generated from a contract, verified in the browser); phase 8 (docs on packages/ui) is next

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
    - The "Completar com" select sat 6.5px low (`de9bcbc`): a native control
      beside a `FormField` must use the same `Label` (leading-none) and the
      `Input`'s height, padding and text size, or the two do not align.

27. **Batches, a template filter and a mixed history in the API** (phase 3:
    `b752260` code, `871eb72` contract).
    - **A batch** is created empty (`POST /v1/batches`), then each document
      joins it through `POST /v1/documents` with `batch_id`. Generation stays one
      synchronous request per document. A batch records its template version;
      a document of another template or version, or naming another account's
      batch, is a 422 on `batch_id`.
    - **`GET /v1/history`** mixes loose documents and batches, newest first,
      paging over ids (UUIDv7 in both tables; a batch is created before its
      documents). `template_id` filters it and `GET /v1/documents`;
      `batch_id` filters `GET /v1/documents`.
    - **`GET /v1/batches/{id}/download`** streams a ZIP in generation order,
      entries stored (a .docx is already deflated) and repeated names made
      unique ("contrato (2).docx"). Charged to the write budget, like the
      export. The batch is read first, so a foreign one is a 404 before any
      byte is written.
    - **`DELETE /v1/batches/{id}`** deletes the documents explicitly, then the
      batch, then orphaned blobs, in one transaction.
    - **Migration `0004_batches.sql`** (0003 was taken by password resets):
      `batches`, `documents.batch_id` (nullable FK, allowed on ALTER because
      its default is NULL), and indexes for both filters.
    - **The export includes batches** and each document's `batch_id`: a batch
      name is typed text and often names people.
    - `sanitizeName(name, extension, fallback)` generalises the filename rule;
      the archive is `<batch name>.zip`.
    - Tests: unit (batch names, archive entry names), integration (history
      order and paging, filters, archive contents, deletion down to blobs,
      rules, isolation, export), all passing with `-race`. The published API
      reference is republished at the same URL.

28. **Documentos is the history** (phase 4, `1b54667`). It reads
    `GET /v1/history` through `server/history.ts` (`getHistory`, which also
    returns every active template for the filter; `listBatchDocuments`;
    `downloadBatch`; `deleteBatch`). `?pagina=` and `?modelo=` live in the URL.
    - A batch row is closed until opened; opening reads its documents with
      `useInfiniteQuery` (`batchDocumentsQuery`), twenty at a time, only then.
    - **Each history entry is its own `<tbody>`**, so an open batch's documents
      are a tbody the toggle's `aria-controls` names. A tbody inside a tbody
      is invalid HTML, which is what the first version produced.
    - Invalidation: `staleAfter.batchChanged` and the history key in the others;
      `listDocuments` and `documentPageQuery` are gone.
    - Links: "Ver documentos deste modelo" on the template screen, and the
      dashboard ranking's counts open Documentos filtered.
    - The history, filter and document rows still need the signed-in check.

29. **Batch generation from a spreadsheet** (phase 5, `705d5fc`), at
    `/templates/$templateId/lote` (file `templates.$templateId_.lote.tsx`: the
    trailing underscore keeps it out of the template screen, which has no
    Outlet).
    - `domain/csv.ts` reads and writes CSV with no dependency: separator from
      the first line **with content** (a blank first line once defaulted it to
      `,`), RFC 4180 quotes, UTF-8 with a Windows-1252 fallback (Excel's
      default). The model spreadsheet is written for Excel in Brazil: `;`,
      CRLF, BOM. **Write the BOM as `"﻿"`**, never the invisible character:
      it did not survive a shell heredoc and nearly shipped wrong.
    - `domain/batch.ts` matches columns by `headerWords`: accents, case,
      punctuation and filler words removed, words sorted, so "Nome do
      locatário" feeds `locatario_nome`. Up to `MAX_BATCH_ROWS` (200).
    - The run is client-side: create the batch, then `generateDocument` with
      `batchId` row by row, waiting out a 429's `retryAfterSeconds`. Stop, retry
      failed rows into the same batch, download the ZIP.
    - Adding `@base-ui/react/progress` (via `shadcn add progress`) is a new
      Base UI subpath: the dev server was restarted with `node_modules/.vite`
      cleared before any browser test, per the gotcha above.
    - **Verified by the user in their own browser (2026-09-14):** a batch of
      six generated from a spreadsheet, shown collapsed in the history with
      its ZIP and delete, next to loose documents.

30. **Drop anywhere, and delete single documents** (`c8b5266`), confirmed
    working by the user.
    - `Dropzone` listens on `window` while mounted: a drag carrying files
      shows a full-screen overlay (pointer-events none) and a drop anywhere
      selects the file. dragenter/dragleave are counted so crossing elements
      does not flicker. **One dropzone per screen** is assumed.
    - History rows, loose or inside a batch, have a trash button calling
      `DELETE /v1/documents/{id}` (`deleteDocument`); batches and documents
      share one `DeleteButton`. `staleAfter.documentDeleted` is tested.

31. **Signed-in review, 2026-09-14**, in the browser pane with the user's test
    account, creating a document and a batch of 3 and deleting both after.
    Verified: dashboard empty and with data (chart, summary, ranking link,
    recent), Templates search and clear, the generation screen (name follows
    the chosen field, "Usar a sugestão", alignment 0px), a loose generation,
    the batch page (a file dropped on the header via the full-screen overlay,
    Google Forms-style headers with accents matched, a row without a name
    left out, progress to 100%, the ZIP read in memory with both entries),
    the history (filter from "Ver no histórico", batch closed and opened,
    `aria-controls` on a tbody, deletes with the right dialog text), 375px
    (drawer closes on navigation, cards, batch card opens, no page scrolls
    sideways), Ajustes (Claro and Papel switch knobs, high contrast), and the
    preferences restored. No console error from the app.
    - Inside an open batch documents were newest first at the time; item 34
      changed that to generation order.
    - The Ajustes tab list is 32px with a 1px subpixel overflow, clipped by
      `overflow-y-hidden`: not visible, not a bug.

32. **Leaving a running batch asks first.** The batch page generates row by
    row in the browser, so leaving mid-run stopped it silently.
    - TanStack Router's `useBlocker` (`disabled` unless `phase === "running"`,
      `withResolver`) blocks links and the back button with an `AlertDialog`
      ("Continuar aqui" / "Sair e interromper"), mounted only while blocked.
      **While registered it also answers `beforeunload`** (`enableBeforeUnload`,
      handled inside `@tanstack/history`), so no listener of our own: a reload
      or a closed tab gets the browser's own prompt.
    - Leaving sets the stop flag, and so does unmounting: an awaiting loop
      outlives its component.
    - **A stop during a 429 wait sends nothing more**, and that row goes back to
      pending ("Continuar") instead of reading as a failure. Before, one retry
      still went out after the stop.
    - The page says beside the progress bar that leaving or reloading
      interrupts the batch.
    - Verified signed in, with request counting: a link and the back button
      open the dialog; "Continuar aqui" restores the address and keeps
      generating; "Sair" stops (no generation request after it); after "Parar"
      or the end, leaving asks nothing and `beforeunload` is not prevented.
      **The batch keeps generating while the dialog is open**, on purpose. Chrome
      shows the reload prompt only after a real user gesture, so synthetic
      clicks cannot show it. Test batches deleted.

33. **The block editor** (`873f7df` writer, `69326c9` editor), the last piece
    of the original plan, approved with TipTap on 2026-09-15. The user then
    asked for the usual formatting and chose: alignment, font size, lists,
    strikethrough/superscript/subscript, indentation, line spacing and page
    breaks (not fonts, colours or tables).
    - **Dependencies:** TipTap 3.31.3, MIT packages only, pinned: core, react,
      pm, extensions (UndoRedo, Placeholder), and extension-document,
      -paragraph, -text, -heading, -bold, -italic, -underline, -strike,
      -superscript, -subscript, -hard-break, -text-align, -text-style, -list.
      Nothing paid, no cloud.
    - **The block model grew** (`domain/block.ts`): `pageBreak` blocks, an
      optional `BlockFormat` (align, lineSpacing 1/1.15/1.5/2, indent steps,
      firstLineIndent, list {kind, level 0-8}) and marks strike, superscript,
      subscript and size in points. `listPositions` groups list paragraphs
      into lists and computes markers; **the preview and the writer both use
      it**, so where a list restarts and what "a)" reads cannot differ. A
      .docx numbering holds one kind per level for a whole list, so the first
      paragraph at a level decides it; a sub-level restarts after an item
      above it, as Word does.
    - **Stored source** `imobiliary/source.json`, `domain/block-source.ts`:
      format `imobiliary.blocks` version 2, still reading 1. `normalizeBlocks`
      is the one canonical form (joins runs, drops unset formats, clears a
      list on a heading or an indent inside a list, superscript wins over
      subscript). **A version is editable only while `describesDocument`
      holds**: the stored tree's text equals the text the reader finds, so a
      template changed in Word afterwards is not silently reverted.
    - **Writer** `infrastructure/docx/build.ts`: A4, Word's built-in heading
      styles (shown as "Título 1"), compatibility mode 15, a
      `word/numbering.xml` with one abstract numbering and one instance per
      list, no author in the properties. Normal is left-aligned, matching
      what the editor shows by default. **Element order in w:pPr (pStyle,
      numPr, spacing, ind, jc) and w:rPr (b, i, strike, sz, u, vertAlign)
      follows the schema; Word rejects anything out of order.**
    - **Reader** `parse.ts` reads the same properties, including numbering
      kinds from `word/numbering.xml`, so previews of Word templates show
      alignment, lists and sizes too. A `w:tab` inside `w:pPr` is a tab stop,
      not a character; it used to become a stray tab in the preview.
    - **Editor** `components/block-editor/`: `block-editor.tsx` (toolbar,
      document, fields panel with insert and rename-everywhere),
      `field.tsx` (the field as an inline atom; typing or pasting
      `{{.nome}}` makes one), `formatting.ts` (line spacing, indent and
      first-line indent as attributes, `PageBreak` with Ctrl+Enter, list items
      limited to one paragraph plus sub-lists, superscript and subscript
      exclusive, **font size drawn in rem** — TipTap writes `pt`, which would
      ignore the text-size preference; 1rem is 12pt at the default root),
      `unsaved-changes.tsx` (the leave guard). `lib/editor-document.ts`
      converts the editor's nested lists to flat numbered paragraphs and
      back, tested. `injectCSS: false`: the editor's rules live in `app.css`.
      The editor loads only on its two routes, in its own chunk.
    - **Screens:** `/templates/criar` ("Criar no editor" beside "Enviar
      modelo") and `/templates/$templateId/editar` ("Editar" on the template
      screen when the latest version is editable; a Word template explains
      why it is not). Saving goes through `createTemplateFromBlocks` /
      `publishTemplateVersionFromBlocks`, which re-check the tree on the
      server, build the file there and upload it like any other.
    - **Proof, beyond the tests:** Word 16 is installed here and was driven
      through COM (`Word.Application`, `DisplayAlerts = 0`, open read-only
      without repair). It opened a contract, a 400-paragraph file and a file
      with every format; it read back centring, justification with 1.5
      spacing and a 1.25 cm first-line indent, right alignment at 14pt, a
      2.5 cm indent, double spacing, mixed strike/superscript/subscript, list
      strings 1. a) b) i. 2. 3., a restart at 1, bullets • ◦ ▪ and two pages.
      A deliberately broken control file failed to open, so the check is
      real. The API's docx engine (a temporary Go test, removed) normalised,
      compiled and rendered the same files, and Word opened the results with
      the formatting intact. **`ExportAsFixedFormat` (PDF) hangs Word under
      automation here; do not use it.** Iterating `Paragraphs` with PowerShell
      `foreach` is also best avoided; index with `Item(i)`.
    - **User feedback:** first version "ficou bom"; formatting added after.
    - **Verified signed in (2026-09-15)**, every toolbar control driven in the
      pane: heading 1 centred; a justified paragraph with 1.5 spacing and a
      first-line indent; right-aligned 14pt; two indent steps and back; double
      spacing; superscript, subscript, strike and bold-italic-underline; a
      numbered list with Tab and Shift+Tab to level i. and back; a page break
      with Ctrl+Enter; a bulleted list nested with the indent button; fields
      typed as `{{.nome}}`, inserted from "Inserir campo" ("Prazo em meses"
      became `prazo_em_meses`) and renamed from the panel. Saved, the template
      screen showed "Editar" and a preview matching the editor; a document
      generated from it, captured in the page and opened in Word, kept every
      format, both lists and two pages, with `&` and `<>` in values. "Editar"
      then: leaving without changes did not ask, leaving with changes did,
      "Salvar como versão 2" published it. A Word template's `/editar`
      explains why it cannot open. Test data deleted.
    - **Fixed during that check:** Ctrl+Enter left the caret before the break
      (it now splits the paragraph and continues after it, as Word does; not
      offered inside a list); a chip inside a paragraph with a first-line indent
      inherited the indent inside itself (`indent-0` on chips, in the editor
      and the preview); the editor drew the second list level as "a." (an
      `@counter-style` makes it "a)", as Word and the preview do); the preview
      note claimed a Word origin for editor templates.
    - **Harness notes:** the pane's `type` inserts a whole string at once, so
      an input rule that fires on the last character only fires when that
      character is typed on its own; the key is `Enter`, not `Return`. TipTap's
      `NodeViewWrapper` passes its `as` prop through to the DOM as an
      attribute: harmless, from the library. A CSP report about a blob worker
      appeared once on the first load of the session, before any script ran;
      its source was not identified and it did not recur.
    - `contrast.test.ts` now normalises CRLF. With `core.autocrlf` a checkout
      writes CRLF, and a Python rewrite in text mode on Windows does too;
      that broke the test once. Rewrite files with `write_bytes`.

34. **The two decisions left from the 2026-09-14 review, put into practice**
    at the user's request (2026-09-15).
    - **Documents inside an open batch are in row order.** The API's
      `GET /v1/documents` takes `order=newest|oldest` (`d912799`, contract
      `7603715`, `aa924f8`): newest by default, anything else a 422 on
      `order`, `DocumentFilter.OldestFirst` in the domain, `ORDER BY id ASC`
      in SQLite (UUIDv7 ids sort by creation). The batch archive now reads
      that order directly instead of reversing a newest-first listing.
      `listBatchDocuments` asks for `oldest`, so the open batch, the ZIP and
      the spreadsheet agree. Integration test
      `TestDocumentsListInGenerationOrderOnRequest` covers default, both
      values, paging and the 422. The reference page was republished at the
      same URL (version 5).
    - **Field labels have their accents** (`beb0914`). `humanize`
      (`domain/placeholder.ts`) maps ASCII words with a single reading in
      lease, sale and registration vocabulary to their accented form
      (`locatario` → "Locatário", `mes` → "Mês", `endereco_do_imovel` →
      "Endereço do imóvel") and capitalises acronyms (CPF, CNPJ, CEP, IPTU).
      **Ambiguous words are deliberately absent** (e/é, pais/país, esta/está):
      a label may stay unaccented but is never wrong. Words not listed stay as
      typed; extend the map rather than guessing in code. The labels reach the
      generation screen, the chips' spoken names, the fields panel, the batch
      page and the model spreadsheet's headers; column matching strips accents,
      so old and new spreadsheets both match.
    - Verified signed in: a batch of three from the model spreadsheet
      (headers "Data › Dia;Data › Mês;Pessoa nome") matched every column and
      listed primeira, segunda, terceira when opened, on the phone-width cards
      as well; the generation screen reads "Data mês". Test batch deleted.

35. **Main platform, phase 0 (in progress)** — plan in `PLANO.md`.
    - Root scripts renamed by project (`9f3c5b7`): `docgen:*`, `docs:*`,
      `imobiliary:*`. `pnpm dev` and `pnpm api:dev` no longer exist.
    - **`imobiliary-api` skeleton** (`97a8945`, `3ceda0a`, `d24add1`, `20c4c28`):
      `domain` value types `Money` (int64 centavos, strict "1500.00"),
      `Rate` (int32 millionths, 4 decimal places, signed), `Date` (calendar
      day, no zone; day 31 clamps to the month's last day), CPF and
      alphanumeric CNPJ (the Receita's example `12.ABC.345/01DE-35` validates),
      with fuzz targets; `platform/fieldcrypt` (versioned AES-GCM keys, AAD of
      table/column/row, org-scoped HMAC blind index); `platform/logging`
      (slog JSON with key-based redaction); `platform/metrics` (hand-written
      Prometheus text format); `platform/config` (fails closed, `.env` loader
      that never overrides the environment); `adapter/postgres` (pgx pool,
      checksum-verified migrator under an advisory lock, `InOrganization`
      transaction with `app.organization_id`); `adapter/http` (`/healthz`,
      `/readyz`, JSON 404, request id, traceparent, access log by route
      pattern); `cmd/imobiliary` with `serve` and `migrate`.
    - **The metrics method is `Expose`, not `WriteTo`**: `go vet` rejects a
      `WriteTo` whose signature differs from `io.WriterTo`.
    - **Put the request-observing middleware innermost.** `ServeMux` records
      `r.Pattern` on the request value it receives; any middleware between it
      and the observer that calls `WithContext` hides the pattern.
    - **pgx pulls `golang.org/x/text`, reachable through SCRAM auth**;
      GO-2026-5970 needed v0.39.0. `govulncheck` is clean after it. The proxy
      sometimes times out over IPv6 from this machine: retry.
    - **Verified against a real PostgreSQL 18** (2026-09-15, `3972387` and the
      commit after it): migration applied then idempotent, `/healthz`,
      `/readyz`, the JSON 404 and the metrics listener answered, `/metrics` is
      404 on the API port, the integration suite passes, `-race` is clean with
      the WinLibs GCC on PATH, and `pnpm security` reports all 13 checks
      passing with the integration suite included.
    - **Three defects that only a real database showed:** a lone field key had
      to carry a version prefix (a bare base64 key now means version 1);
      `field_key_version` was logged as `[redacted]` because the redactor
      matches "key" (renamed `field_seal_version`); every access log read
      duration 0, since `slog.Duration` logs nanoseconds and Windows' clock
      granularity rounds a fast handler to zero (now `duration_ms`).
    - **Local database setup cost an hour of password mismatches.** The roles
      are in `scripts/setup-local.sql`; passwords live in
      `%APPDATA%\postgresql\pgpass.conf`, and the test role's line uses `*`
      for the database because each test creates its own. `pgtest` now reads
      `imobiliary-api/.env` itself, so `pnpm imobiliary:test:integration` needs
      nothing exported. A leftover `imobiliary_template_<digest>` database is
      deliberate and reused.
36. **`packages/ui` and `web`** (`036ef84`, `91a0137`), the rest of phase 0.
    - **`packages/ui`** holds what both platforms must agree on: the three
      themes and both high-contrast palettes, the rem type scale, the base
      layer, the accessibility preferences and their head script, the fonts,
      and `cn` with the scale. Components stay per app, as shadcn intends.
    - **Tailwind is not imported by the package.** Its source detection starts
      at the stylesheet that imports it, so from the package it would scan the
      package instead of the app. Each app keeps
      `@import "tailwindcss"`, `tw-animate-css` and `shadcn/tailwind.css`, then
      imports `@imobiliary/ui/tokens.css`.
    - **The localStorage key is a parameter now**, through
      `accessibilityStorage(key)`: `web` uses `imobiliary_accessibility`, and
      `docs` keeps `imobiliary_docs_accessibility` when it migrates.
    - **A third font, Inter Variable**, as `--font-reading` (`font-reading`),
      for text that is read rather than scanned and for columns of money.
    - `docs` had its own copies until phase 8 (item 48), which replaced them
      with the package.
    - **`shadcn init` asks for a project name even with `-y`**, and it creates
      the project in a subdirectory of that name. Piping answers in gives the
      directory a name made of the piped text; the contents were moved up and
      the rest of the scaffold (eslint, prettier, vitest, devtools, Lucide,
      Geist) dropped.
    - `web` runs on **:3001**, has `.claude/launch.json` entry "web", and the
      root gains `web:*` and `ui:check`. `pnpm security` is 15 checks (16 since item 39).
    - **The production start is solved, for both platforms** (`f19f30d` and the
      commit after it). `vite build` produces `dist/client` and a
      `dist/server/server.js` that default-exports a `{ fetch }` handler: it
      listens to nothing and serves no files, which is why running it directly
      had produced nothing. `server.mjs` in each platform adapts it with
      **srvx** (the new dependency, chosen by the user) and puts
      `serveStatic({ dir: "./dist/client" })` in front, so an asset never
      reaches the router. `PORT` and `HOST` configure it; it binds to loopback,
      since a TLS-terminating proxy belongs in front either way. `pnpm start`
      in both platforms now runs it.
    - **Vite inlines small assets as data: URIs, and the CSP refuses them.**
      One font face is under the limit, so a production page logged
      "violates ... font-src 'self'" and fell back to Times. Only a production
      build shows it: the dev server serves every asset as a file. Both
      `vite.config.ts` files now return `false` from `assetsInlineLimit` for
      font extensions, rather than widening the policy to `data:`.
    - **`docs` in production answers 500 on every page, on purpose**: the
      controller identity in `src/domain/legal.ts` is still a placeholder and
      `assertLegalIdentityComplete` refuses to serve. Its static files and
      favicon are served, so the start itself is proved; the guard is the
      legal item, not a bug.

37. **Phase 1, the API half** (`067b5fe` use cases, `8d95e5d` HTTP), all of it
    behind `PLANO.md` §7 phase 1.
    - **Migrations 0002 and 0003**: organisations, users, memberships, refresh
      tokens, password resets, invitations, `user_totp`, recovery codes, MFA
      challenges; then `audit_events` and `access_records`. RLS is deliberately
      absent from the identity tables: signing in happens before an
      organisation is known.
    - **`audit_events` revokes UPDATE and DELETE from the application role**,
      so the trail cannot be quietly corrected, and its foreign keys set null
      rather than cascade: erasing a person must not erase the evidence.
    - **Access records for the Marco Civil (art. 15)**: IP, source port and
      instant, kept six months and swept hourly. Not partitioned, on purpose:
      an office writes thousands of rows in six months.
    - **Ed25519 access tokens**, so another service can verify without being
      able to mint. The key's name is in the header; keys rotate. A test
      re-signs a token as `none` and as HMAC with the public key, both refused.
    - **TOTP is ours**, RFC 6238 over the standard library, reproducing the
      RFC's vectors. **Confirming an enrolment records the step it accepted**,
      so the next code must belong to a later step: in a test, ask for
      `totp.Step(now)+1` rather than waiting thirty seconds.
    - **The rules the user chose are enforced and tested**: an admin must hold
      a second factor and may not disable it; an office never loses its last
      admin; removing a member ends their sessions; one challenge is one
      attempt; one invitation link joins once.
    - **A token minted in the same second as a password change survives it**,
      because a JWT issue time carries whole seconds. The integration test
      sleeps past a second boundary on purpose, as docgen's does.
    - **json/v2 matches field names exactly.** A test struct without tags reads
      nothing and fails with empty values, which cost two rounds here.
    - **A nil `[]string` reaches PostgreSQL as NULL**, not as an empty array;
      the audit repository now always sends a list.
    - `.env` needs **`IMOBILIARY_TOKEN_KEYS`** and either a Resend key or
      `IMOBILIARY_MAIL_LOG=true`, or the service refuses to start.
    - **Not done in phase 1 yet:** the web half (public screens, app shell,
      settings, legal pages), the OpenAPI document, and account deletion and
      export.

38. **Phase 1, the web half** (`4568c4b` session layer, `8cb8549` screens,
    `2cee26a` fixes found in the browser).
    - BFF as in `docs`: `SessionManager`, `RefreshCoordinator`, sealed cookie
      `imobiliary_session`, which also stores the active organisation, the role
      and whether the second factor is still owed. `_app` sends an admin without
      TOTP to `/ajustes?aba=seguranca` and nowhere else.
    - Screens: `/entrar` (two steps; one challenge is one attempt, a refused
      code goes back to the password), `/criar-conta`, `/esqueci-senha`,
      `/redefinir-senha`, `/convite`, `/dashboard` (placeholder), `/ajustes`
      (Aparência, Acessibilidade, Segurança with password and TOTP, Escritório
      with members, and invitations for admins only), `/privacidade`,
      `/termos`, `/licencas`, robots and sitemap.
    - **A blocked submit is not counted by TanStack Form**, so errors on
      fields never left stayed hidden. Each form keeps its own `attempted`
      flag; copy that pattern into every new form.
    - **After a server function rotates the session, call
      `router.invalidate()`**: the guard's context keeps the old answer.
    - **An SSR loader's request has no `Origin`**, so `assertSameOrigin` in a
      server function called from a loader always refuses. Only mutations
      called from the browser carry the check.
    - **Harness:** the pane's typing does not reach React-controlled inputs
      reliably. Set values with the native `HTMLInputElement` value setter and
      an `input` event, then `form.requestSubmit()`. After an HMR edit mid-test,
      reload before trusting what a form does.
    - Verified 2026-09-16 against the API on :8085 with `IMOBILIARY_MAIL_LOG`:
      everything listed in the commit `2cee26a`.

39. **Phase 1 closed: account export and deletion, and the OpenAPI**
    (`6513ebe` API, `c853f54` web, `462a584` contract).
    - **`GET /v1/me/export`** (LGPD art. 18, II) and **`POST /v1/me/deletion`**
      (art. 18, VI, with the password; a POST because a DELETE body may be
      dropped). Both are reachable before second-factor enrolment. The export
      carries no secret and is audited.
    - **Migration 0004** drops the foreign key on `access_records.user_id`:
      it used to null the id on deletion, which left the Marco Civil records
      naming nobody. `closed_accounts` keeps the deleted account's address
      sealed (table `closed_accounts`, column `email`, row = user id); both go
      after six months in the hourly sweep. Audit entries keep no actor; each
      office gets `user.deleted`.
    - **Deletion rules:** the only administrator of an office with other
      members is refused with 422 on `organizations`; an office whose only
      member is the account is deleted with it. **From phase 2 on, that second
      rule deletes an office's people and contracts: revisit it against the
      legal retention in `PLANO.md` §6.3 before business data exists.**
    - **Web:** Ajustes gains "Meus dados" (`components/settings/data-panel.tsx`,
      `server/privacy.ts`, `PrivacyGateway`). Privacy policy 1.1.
    - **A wrong password on any authorised call costs two verifications**:
      `SessionManager.authorize` reads a 401 as an expired token, rotates and
      retries. Harmless, but it shows twice in the log and in the credential
      bucket. Distinguishing a refused password from a refused token would
      need a different API code.
    - **`openapi.yaml`** covers all 23 routes; `TestOpenAPIDescribesEveryRoute`
      compares it with `server.go` as text and was proved to fail on drift.
      Redocly lint is in `pnpm security` (16 checks). The readable reference,
      `imobiliary-api/docs/api-reference.html`, is published at
      `https://claude.ai/artifact/KPjGcnhCBB93KuekDTeMao`; republish that file
      to the same URL when the contract changes.
    - **Harness:** after a Vite restart the page can be served before it
      hydrates; elements then have no `__reactProps` keys and clicks do
      nothing. Wait, reload, and check for those keys before driving a form.
    - Verified in the browser: a member's export (eight sections, no token or
      hash), a wrong password kept the session, the only administrator was
      refused in Portuguese, and a member was deleted and could not sign in.
    - `imobiliary-api/PRIVACIDADE.md`, the article 37 record, was written with
      phase 2 (item 40).

40. **Phase 2: people and addresses** (`f7ed833` API, `dcc0705` contract and
    `PRIVACIDADE.md`, `9e16053` web).
    - **The user decided (2026-09-16): closing an account never erases an
      office's data.** Business tables reference `organizations` with
      `RESTRICT`; deleting the account of an office's only member while it
      holds people is refused with 422 on `organization_data`. Every later
      business table must keep that `RESTRICT`.
    - **Migration 0005**: `people`, `individuals`, `companies`,
      `company_representatives`, `addresses`, `person_addresses`. Every table
      has `organization_id`, a policy on `app_organization_id()` and **FORCE
      ROW LEVEL SECURITY**, so the owner is bound too: the integration suite
      runs as owner and a missing policy fails a test. Repositories filter by
      nothing else. Composite FKs on `(organization_id, id)` keep links inside
      one office. `app_organization_id()` wraps `current_setting` in `NULLIF`,
      because `''::uuid` is an error, not a non-match.
    - **`DB.InOrganization(ctx, org, fn(usecase.ScopedRepositories))`** is the
      port business use cases use, reads included; the pgx-level helper is
      `InOrganizationTx`. Copy this for properties, contracts and rents.
    - Sealed against table, column and row: email, phone, CPF, CNPJ, birth
      date. CPF and CNPJ also get a blind index `Index(org, "cpf:"+digits)`,
      unique per office. Names stay clear for trigram search over
      `immutable_unaccent(lower(name))`; LIKE wildcards are escaped. The list
      is alphabetical with a keyset cursor (base64url JSON of folded name and
      id).
    - **PostgreSQL reports a RESTRICT violation as 23001, not 23503.**
      `isForeignKeyViolation` accepts both; the first run returned 500s.
    - Rules: kind never changes; a spouse is an individual registered as
      married or in a stable union and not linked elsewhere, written on both
      records (`SetSpouse` bumps the other's version); representatives are
      individuals; a linked person is `409 in_use`. Edits need `If-Match`
      with the `ETag` version: missing 428, stale 412. Audit entries name
      changed fields only.
    - **Web:** `domain/person.ts` (rules, masks, labels,
      `translatePersonProblem` so no English API message reaches a screen),
      `PeopleGateway`, `server/people.ts`, `components/people/person-form.tsx`
      and `person-picker.tsx`, routes `/pessoas`, `/pessoas/nova`,
      `/pessoas/$personId`. Failures gain `stale` and `in_use`.
    - **TanStack Form types array helpers as `never` over readonly arrays**;
      the form uses its own `PersonFormValues` with mutable lists. The API's
      snake_case field errors map onto form paths with `formPath`.
    - **Heredocs:** a `python - <<'EOF'` whose body holds certain quote mixes
      failed in this bash with "unexpected EOF". Write the script to the
      scratchpad with the Write tool and run it instead.
    - Verified in the browser against the user's own servers (web :3001, API
      :8081): everything listed in commit `9e16053`. Test records deleted.
    - **Not done:** TanStack Query and Table are still not in `web` (the list
      uses loaders and a cursor); no export of people for portability.

41. **Phase 3: properties** (`a8c5ed6` API, `f6d1469` web).
    - **The user asked (2026-09-16) that the API and the web dev server stay
      running while work goes on.** The API now runs in the background with
      `pnpm imobiliary:dev` on :8081 (the user's own `web/.env` points there);
      after a migration, run `pnpm imobiliary:migrate`, stop whatever listens
      on :8081 and start it again. The web dev server on :3001 is the user's
      and reloads by itself. Inputs also carry placeholders now (see the
      "Imobiliary (main platform)" section).
    - **Migration 0006**: `properties` (address row of its own, matrícula,
      cartório, IPTU, water and energy codes, version) and `property_owners`
      (share in millionths), with the item 40 guarantees. The owner link to
      `people` is RESTRICT, so an owner is `409 in_use`.
    - **Shares add up to exactly 100**, checked by the domain and again by a
      **deferred constraint trigger at commit** (`check_property_shares`,
      SQLSTATE 23514), since replacing owners deletes and inserts row by row.
      A second trigger on `properties` catches a property with no owner.
    - Updating keeps the address row's id; deleting removes owners and the
      address. The list orders by folded street and number, searches the
      address, matrícula and IPTU, and filters by `owner_id`.
    - `NormalizeAddress` / `validateAddressLines` are shared by people and
      properties in Go; `addressLineProblems` in the web domain.
    - **Web:** `domain/property.ts` keeps shares in millionths (`parseShare`
      accepts a comma, `splitEvenly` gives the remainder to the last owner),
      `components/properties/property-form.tsx` with a live total and
      "Dividir igualmente", routes `/imoveis`, `/imoveis/novo`,
      `/imoveis/$propertyId`, a person's record lists what they own.
      `SelectField` is shared in `components/select-field.tsx`;
      `PersonPicker` takes an optional `kind`.
    - Verified in the browser: everything listed in commit `f6d1469`. Test
      records deleted.

42. **Two defects the user reported before phase 4.**
    - **Submit with `submitForm(form)` (`lib/form.ts`), never
      `form.handleSubmit()`.** TanStack Form's `_handleSubmit` returns on a first
      attempt when the form already holds an error, without validating again.
      With `blurThenChange` an error can be computed and kept hidden (leaving an
      address field while the owners list was empty) and outlive the change
      that fixed it (adding the owner, which validated nothing because no field
      showed an error). The first click on "Cadastrar" then only revealed the
      stale error. `submitForm` runs `form.validate("submit")` first; every form
      uses it, and `form.test.ts` proves the bug with `handleSubmit` and the fix.
      In the pane the bug only reproduces when fields really lose focus:
      dispatch `focusout`, since the tab never holds focus.
    - "Dividir igualmente" and the running total show only with two owners or
      more.
    - **Icons beside a label sit 1px high on purpose** (`button.tsx`,
      `[&_svg]:-translate-y-px`, undone on the icon sizes). Fustat's ascent (13)
      dwarfs its descent (5), so the capitals centre about 1.1px above the box
      and the icon looked low; measured with canvas font metrics at 13.5px and
      12.8px, 0.1px after the fix.

43. **CPF required, and a single owner has no share field** (user's requests,
    2026-09-16).
    - **Every individual carries a CPF.** The user ruled it is not optional: it
      identifies the person. The Go domain answers `cpf: is required`,
      migration 0007 makes `individuals.cpf` and `cpf_index` NOT NULL (it
      fails on purpose if an individual without one exists), the web form
      says "Informe o CPF." and lost its "Opcional" hint. CNPJ stays optional
      for companies. Integration tests build individuals with `individual(name)`,
      which draws a valid, distinct CPF from `nextCPF()`.
    - **The share field shows only with two owners or more.** A single owner
      holds 100%: `validateProperty` skips shares for one owner,
      `ownersToSave` sends "100" whatever the hidden field held, and removing
      down to one owner sets the remaining share to 100.
    - `pgtest` retries `DROP DATABASE ... WITH (FORCE)` for five seconds: once a
      passing test failed its cleanup on SQLSTATE 42501, most likely an
      autovacuum worker the test role cannot terminate.

44. **Phase 4: contracts and instalments** (`f829849` API, `157b619` web).
    - **Migration 0008**: `contracts`, `contract_parties`,
      `contract_acknowledgments`, `rents`, all FORCE RLS and RESTRICT to the
      office. `contracts_one_lease_per_property` is a gist exclusion over
      `daterange(starts_on, COALESCE(terminated_on, expires_on), '[]')`, so a
      termination frees the property from the next day. It answers 23P01,
      turned into a 422 on `starts_on`.
    - **Domain** (`domain/contract.go`): structural rules, `TermMonths`
      (whole months, one more for a remainder), `Schedule` (instalment 1 on
      the start, then `due_day` clamped to the month), `Notices` and
      `MissingAcknowledgements` (422 on `acknowledgments` whose message is the
      code). `adjustment_period` from the plan belongs to amendments (phase 5)
      and is not raised yet.
    - **Landlords default to the property's owners** when the request names
      none. Guarantors and their spouses must be individuals.
    - **Editing regenerates the schedule** and is refused once a rent is paid
      (`rents`) or after a termination. Notices acknowledged before still
      count; a notice no longer raised loses its row, the audit keeps it.
    - **Termination** removes unpaid rents due after the day, in the same
      transaction. A paid contract cannot be deleted (`409 in_use`).
    - **PostgreSQL cannot infer the type of a parameter no clause uses.** The
      list first added "today" for every status filter and `terminated`
      answered 500; parameters are now added only by the clause that reads them.
    - Routes: `GET/POST /v1/contracts`, `POST /v1/contracts/preview`,
      `GET/PUT/DELETE /v1/contracts/{id}`, `POST /v1/contracts/{id}/termination`.
      OpenAPI 0.4.0 (a `Money` and a `Date` schema now exist), reference page
      republished at the same URL (version 5), `PRIVACIDADE.md` extended.
      "Today" is computed in America/Sao_Paulo.
    - **Web:** `domain/contract.ts` (labels, notice texts in Portuguese, money
      and percent parsing, `termMonths` ported exactly from Go, validation,
      `translateContractProblem`), `ContractsGateway`, `server/contracts.ts`,
      `components/contracts/contract-form.tsx` (four steps: Imóvel, Partes,
      Valores e prazo, Revisão), `status-badge.tsx`,
      `components/properties/property-picker.tsx`, routes `/contratos`,
      `/contratos/novo`, `/contratos/$contractId`,
      `/contratos/$contractId/editar` (file `$contractId_.editar.tsx`).
    - **Each step validates only its fields** with the domain validator
      filtered by `stepOfField`; a refusal from the API on save moves to the
      first step holding a refused field. The review calls the preview on
      entering and shows a checkbox per notice.
    - Sidebar: Contratos is live; Aluguéis is the "em breve" entry.
    - **Harness:** server functions can be driven from the page with
      `await import('/src/server/people.ts')`, since Vite serves the source.
      That is how the test records were created and deleted.
    - Verified in the browser: the full creation with surety and both notices,
      day 31 clamped to 30/11 and 28/02, refusal until acknowledged, the edit
      adding the spouse (one notice left, the old acknowledgement still
      ticked), a repeated number sent back to step 1 and an overlap to step 3,
      termination with a date before the start refused then accepted (3 rents
      left), list filters and search, property deletion refused while the
      contract existed, 375px without sideways scroll. Test data deleted.
    - **Advance rent is a choice** (user's request, 2026-09-16; migration
      0009, `advance_rent` required in the request, OpenAPI 0.4.1). In
      advance: instalment 1 on the start, then the due day of each following
      month, and the `advance_rent` notice when there is a guarantee. Not in
      advance: instalment k on the due day of the kth month after the start,
      and no notice. Existing contracts became `true`. The choice sits beside
      the guarantee in the Partes step.
    - **Termination prorates the last month** (user's rule, 2026-09-16).
      `RentPeriod(c, n)` is the month instalment n pays, counted from the
      start date's monthly anniversaries whatever the due day.
      `PlanTermination` keeps instalments up to the one whose month holds the
      termination day, removes the rest, and charges that month
      `amount × days run / days in month` (termination day included, half up
      to the centavo, `Prorate`) unless the termination is the month's last
      day. Paid instalments are never changed, and a paid later month refuses
      the termination (422 on `terminated_on`). OpenAPI 0.4.2. The web marks
      the prorated rent "proporcional".

45. **Phase 5: rent adjustments** (`b7fed1c` API, web in the commit after it).
    - **Migration 0010** `amendments`: day, the contract's index at the time,
      signed rate, previous and agreed rent, and the acknowledgement of the
      period notice (`period_acknowledged_by/_at`). One per contract per day.
    - **Domain** (`domain/amendment.go`): `SuggestedRent` (a rate at or below
      zero keeps the rent), `ValidateAmendment` (after the start, within the
      term, after the last adjustment, never on a terminated contract),
      `AmendmentNotices` (`adjustment_period` under twelve months from the
      start or the last adjustment, Lei 10.192/2001 art. 2º § 1º),
      `FirstAdjustedSequence` and `PaidFrom`.
    - **Which instalments change: the unpaid ones whose month
      (`RentPeriod`) starts on the adjustment day or later**, not "due on or
      after" as §3.7 first said: with rent paid after each month, a rent due
      after the day can pay a month before it. A running month keeps its rent.
      A paid instalment from that month on refuses the adjustment.
    - **Undo** removes only the last adjustment, while the contract runs and
      nothing it reached is paid; it puts `previous_rent` back the same way.
      Adjusting and undoing need the contract's `If-Match` and bump its
      version. **`PUT /v1/contracts/{id}` is refused on `amendments` once a
      contract was adjusted**, since regenerating the schedule would erase it.
    - Routes: `POST /v1/contracts/{id}/amendments/preview`,
      `POST .../amendments`, `DELETE .../amendments/{amendmentID}`; the
      contract body has `amendments`. OpenAPI 0.5.0, reference republished.
    - **Web:** `components/contracts/amendments.tsx` on the contract page
      (list, "Registrar reajuste" dialog with a live preview of the suggested
      rent, the instalments reached and the notice, "Desfazer" on the last).
      "Editar" hides once a contract has adjustments.
    - Verified in the browser after the user signed in again: an adjustment
      before twelve months (preview R$ 1.500,00 to R$ 1.567,50, 28 open rents
      from 10/06/2027, notice shown and blocking until acknowledged), saved
      with a negotiated R$ 1.560,00 (instalment 8 kept, 9 on moved, "Editar"
      hidden), then undone (rents and "Editar" back). No console error. Test
      data deleted.
    - The development database showed migration 0010 applied at 21:35 before
      `pnpm imobiliary:migrate` ran; neither `serve` nor the tests migrate
      it, so it was run outside the session.

46. **Phase 6: rents and the dashboard** (`561b5d5` API, web in the commit after it).
    - **Migration 0011** `rent_charges` (condominium, IPTU, water, energy,
      other with a description), plus indexes for rents paid by day and rents
      by due day; `rents` gained `UNIQUE (organization_id, id)` for the FK.
    - **Late fee** (`domain.ComputeLateFee`): the penalty rate on the rent with
      its charges, plus the monthly interest rate prorated over a **thirty-day
      month** (the commercial month, confirmed by the user on 2026-09-16) per
      day after the due day, each part half away from zero to the
      centavo; nothing on or before the due day. The office can type over it.
    - **Payment in full only**: `late_fee` and `amount_paid` default to the
      computation; `paid_on` not after today (São Paulo). `UPDATE ... WHERE
      paid_on IS NULL`, so the second of two simultaneous payments is 409
      (tested with two goroutines). Reversal clears the payment. Charges change
      only while unpaid. **A contract with charges can no longer have its
      terms replaced** (`rents`), since regenerating the schedule would drop
      them. All audited (`rent.*`).
    - **`GET /v1/dashboard`** as of today: month expected/received/open and
      the administration fee (`round((rent_amount + charges) × admin_fee)`
      on rents received this month; **the user ruled on 2026-09-16 that the
      fee is charged on the rent with its charges, never on the late fee**),
      overdue totals, portfolio (properties,
      leased, running contracts, rent roll), contracts ending within 60 days,
      adjustments due within 30 days (index set, twelve months from start or
      last amendment), up to 20 rents due today and overdue.
    - Integration tests build leases starting three months before today, since
      "today" is the real clock there.
    - **Web:** `domain/rent.ts` (types, labels, `todayInSaoPaulo`, month
      helpers, validation, translations), `RentsGateway`, `server/rents.ts`,
      `components/rents/payment-dialog.tsx` (status badge, the payment dialog
      with the late fee previewed for the typed day), routes `/alugueis`
      (month or all overdue, search, pay inline) and `/alugueis/$rentId`
      (values, charges add/remove, pay or reverse), the dashboard with cards,
      "Vencem hoje", "Em atraso" and the two deadline lists. Aluguéis is live in
      the sidebar ("em breve" is gone); contract rents link to their page and
      show charges.
    - **Verified in the browser (2026-09-17)**, on a lease started three
      months back, beside the user's own records (left untouched): four
      overdue rents with the right days late; a condominium charge moved the
      late fee for today from R$ 163,73 to R$ 204,67; the payment dialog
      refused a future day and recomputed for 5 days (R$ 2.203,33); paid, the
      charges locked; the dashboard read R$ 2.203,33 received and R$ 200,00
      fee (10% of rent plus charge), R$ 4.800,00 overdue; paying another rent
      from the dashboard with the fee waived gave R$ 3.803,33 and R$ 360,00;
      reversal brought it back to R$ 1.600,00 and R$ 160,00; removing the
      charge and "Outra" without a description both behaved. At 375px no
      screen scrolls sideways; rent rows now put the address on its own line
      below `sm`. Test data deleted.
    - **Fixed: two tabs reloading together revoked the session.** A request
      with the old refresh token arrived just after single-flight had released
      the rotation, and the API took it as a replay. `RefreshCoordinator`
      (web and docs, identical) now also answers a consumed secret with the
      rotation that consumed it for `ROTATION_GRACE_MS` (10 s), kept in memory
      and swept; a failed rotation is not remembered. Tested in both.

47. **Phase 7: the docgen integration**, planned in `PLANO-FASE-7.md` with the
    user (migration by e-mail, templates owned by the office, review before
    generating, documents in both the contract and the Docs history, the CIN
    repeating the CPF, a `{{.foro}}` of its own, gender from each person's
    register, and Docs keeping its own sign-in screen).
    - **The fields a lease is filled with** (`234e3d3`, `bfd7443`):
      `domain/words.go` (numbers, money and rates in Portuguese words, with
      gender agreement) and `domain/qualification.go` (each party's
      qualification, `Term`, `Title`, and the contractions `_do`, `_ao`, `_no`,
      `_pelo`, the sentence start `_termo_inicio` and the agreement ending
      `_o`, so a clause can read "obrigad{{.locatario_o}}").
      `GET /v1/contracts/{id}/document-fields` answers them; nothing is stored.
      OpenAPI 0.7.1.
    - **The token** (`5054e99`): `POST /v1/sessions/docgen-token` mints a
      five-minute Ed25519 token, audience `docgen`, carrying the user, the
      office, its name, the e-mail and the role. `imobiliary public-keys`
      prints what verifies it; this API refuses it, since the audience is not
      its own.
    - **docgen stopped holding identity** (`24de6ad`, `611ede6`): migration
      0005 rebuilds the tables around an `owners` row per office, verifies the
      platform's tokens with public keys only, and claims a legacy account the
      first time a member signs in with its e-mail. The old auth routes answer
      `410`; documents gained `reference` and a filter on it. docgen's OpenAPI
      is 2.0.0 and its reference page is now published at
      **https://claude.ai/artifact/V9NL1MbyiRPCvXpYCSxDky**.
    - **docgen reads a `.env` beside the command** (`2adf2e6`). It never did,
      so `DOCGEN_IDENTITY_PUBLIC_KEYS` had to be exported by hand; the loader
      is the one this API uses. Local `.env` holds the platform's public key.
    - **The marked test model** (`cdc9779`): `modelos/`, a copy of the model
      the user gave, with every value replaced by a field name. The original is
      untouched; the README says what changed, including the forum clause the
      model did not have.
    - **`packages/docx`** (`6ce9931`): the block model, the .docx reader and
      writer, the placeholder rules and the preview moved out of `docs`, so
      both platforms read a file the same way. `docs` imports them and is
      otherwise unchanged; `cn` comes from `packages/ui`.
    - **Docs signs in with the Imobiliary account** (`c76db7b`). Its cookie now
      holds the platform's session plus the office and role, and every call to
      the document service carries a token minted from it (`DocgenTokenCache`,
      per account and office, dropped on refusal; a refusal that survives a
      refresh clears the session). Sign-up, recovery and the second factor link
      to the platform; `/criar-conta`, `/esqueci-senha` and `/redefinir-senha`
      are gone, as are the password and deletion panels. Privacy policy 2.0.
    - **The contract generates its own documents** (`f5d7763`): "Gerar
      documento" picks a template, shows it filled with `document-fields` and
      editable in place, and generates with `reference contract:<id>`; the
      contract's Documents section reads a document inside the platform,
      downloads it and deletes it. A field the template asks for and the
      contract cannot answer is named and left to be filled.
    - **Verified in the browser (2026-09-17)** on the user's own contract
      2026/001, with the API on :8081, docgen on :8080, web on :3001 and docs
      on :3000: the office's templates appeared (the legacy docgen account had
      migrated by e-mail), the review flagged the three fields the contract
      does not answer, the document generated, listed, opened in the viewer
      with the values in place, and Word read it back through COM
      ("Olá Marilia Roberta de Sá…", "Colina/SP, 17 de setembro de 2026.").
      The test document was deleted and the user's records were left as they
      were. On Docs, the new sign-in screen refused a wrong password against
      the platform and its links point at imobiliary.com.
    - **Each party is answered field by field** (`f6caaae`), after the user
      said the qualification paragraph was the wrong shape: a paragraph
      written by the API fits one model and no other. Every role now also
      answers `locador_1_nome`, `locador_1_cpf`, `locatario_2_estado_civil`
      and so on, numbered to `MaxPartiesPerRole` (4) with the 30 suffixes in
      `domain/person_fields.go`; the paragraph stays for whoever wants it.
      The contract gained the property's address line by line, its utility
      accounts and owners, the office's name, the guarantee kind, plain-number
      variants of money and rates, long dates, `hoje`, and the rent as it
      stands after adjustments: 443 fields. Each person also has `_o` and `_a`,
      the endings that agree with that person alone ("inscrit{{.locatario_1_o}}",
      "portador{{.locatario_1_a}}"), and the marked model in `modelos/` is
      written field by field with them; the docgen engine filled it and Word
      read it back. **`imobiliary-api/docs/campos.md`
      is the catalogue**, in Portuguese, and `TestEveryFieldIsDocumented`
      fails when a field is added without being written there. The same
      catalogue is published for the user at
      https://claude.ai/artifact/3dsJQEkMPa9iHfdLpq1iGD. OpenAPI 0.8.0, whose
      enum of names became a pattern and a description.
    - **Not verified here:** the signed-in half of Docs against the new
      service (templates, generation, history), which needs the user's own
      password, and the marked model uploaded as a template, which is an
      upload on Docs. The model was filled with contract 2026/001's real
      fields (fetched through the platform) by the docgen engine on
      2026-09-21, and read correctly.

48. **Phase 8: `docs` on `packages/ui`**, in a commit of its own.
    - `docs/src/styles/app.css` now imports `@imobiliary/ui/tokens.css` after
      Tailwind, exactly as `web` does, and keeps only the block editor's rules.
      `lib/utils.ts` re-exports `cn` from the package, and
      `lib/accessibility-storage.ts` builds the storage with
      `accessibilityStorage("imobiliary_docs_accessibility")`, the key the
      privacy policy names; changing it would drop every reader's saved
      preferences. The settings panels import `@imobiliary/ui/accessibility`.
    - Removed as copies: `domain/accessibility.ts` and its test,
      `lib/accessibility-storage.test.ts`, `lib/utils.test.ts`,
      `styles/contrast.test.ts`. The package holds and tests all of them, so
      the notes in items 18 and 20 about those files now mean
      `packages/ui/src/`. `docs` lost its direct `cn` and font dependencies;
      the Open Graph source reads the font files from the package.
    - **Proof:** before touching anything, the computed style of every
      element and pseudo-element of `/`, `/entrar`, `/privacidade`, `/termos`
      and the 404 page, at 1280px, in Escuro, Claro and Papel, was hashed (15
      hashes, the first repeated to show it is stable). After the change, with
      the dev server restarted on a cleared `node_modules/.vite`, all 15 were
      identical. The package's only addition, Inter, is declared and emitted
      by the build but never downloaded, since no `docs` page uses
      `font-reading`.
    - **An iframe cannot do this measurement**: `frame-ancestors 'none'` blocks
      it. The hashes were taken by navigating the tab itself, with the
      snapshot function kept in `sessionStorage`.
    - Checks: `pnpm check` in `docs` (117 tests), the production build, and the
      two settings panels and `AppearanceSync` loaded in the browser. Ajustes
      was then seen signed in (2026-09-21): theme, "Seguir o sistema", high
      contrast, text size and "Restaurar padrões" all apply and are saved
      under the old key.

49. **A search validator must name every key it owns** (found checking Docs'
    Ajustes). TanStack Router merges a route's validated search over its
    parent's, and the root keeps the raw parameters, so a validator that
    merely leaves a refused key out lets the raw value through:
    `/ajustes?aba=conta` selected no tab and showed an empty page, and an
    invalid `?mes=` or `?versao=` reached the loader as text. Every
    validator in both apps now returns each key, `undefined` when refused,
    and the types say `?: T | undefined` (`exactOptionalPropertyTypes` is
    on). The router leaves undefined keys out of the address. **Write every
    new `validateSearch` this way.**

### Next step

Every phase of `PLANO.md` §7 is done. What the plan left out of this
implementation, to be planned with the user before any of it starts: payouts
to owners, partial payment, automatic anonymisation when the legal retention
ends, encryption at rest, and CI. The open items below still stand.

Not in the editor on purpose, for now: fonts, colours, highlight, tables,
images, headers and footers. Tables are the costly one: the block model,
writer, reader and preview would all change.

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
pnpm docgen:dev   # the docgen API on :8080
pnpm docs:dev     # the docs platform on :3000
```

`docs/.env` needs `SESSION_SECRET` (32+ chars) or the platform refuses to
start. `DOCGEN_API_URL` defaults to `http://127.0.0.1:8080` and
`IMOBILIARY_API_URL` to `http://127.0.0.1:8081`, where each API binds;
`IMOBILIARY_APP_URL` (default `http://localhost:3001`) is where the sign-up and
recovery links point. `docgen-api/.env` needs `DOCGEN_IDENTITY_PUBLIC_KEYS`,
the output of `go run ./cmd/imobiliary public-keys` in `imobiliary-api`, or the
service refuses to start. It reads that file itself since phase 7; the old
`DOCGEN_JWT_SECRET` and `DOCGEN_MAIL_LOG` are gone.

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
- **Nothing has ever been deployed from this repository**, though both
  platforms now start from a production build with `pnpm start` (item 36).
  What a deployment still needs: TLS in front, the controller identity filled
  in, and the environment each process reads.
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
- The published docgen API reference lives at
  `https://claude.ai/artifact/V9NL1MbyiRPCvXpYCSxDky` since the phase 7
  rewrite (version 2.0.0, office-owned, no auth routes). Update it by
  republishing `docgen-api/docs/api-reference.html` **with that URL**, or a
  second artifact is created instead. The old
  `e3eaf9ee-95d7-46a0-bd7f-d596a95345ee` address is the pre-phase-7 copy.
