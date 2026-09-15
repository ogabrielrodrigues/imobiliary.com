# Imobiliary

Property management for independent brokers, small agencies, and owners who want
real control over their portfolio.

This repository holds the document side of that product: an API that renders
standardised Word documents from user-supplied templates, and the web platform
people use to work with it.

## Layout

| Directory | What it is | Runs at |
|---|---|---|
| [`docgen-api/`](docgen-api) | The document rendering API, in Go | A private subdomain |
| [`docs/`](docs) | The web platform, in TypeScript | `docs.imobiliary.com` |

`docgen-api` is a self-contained Go module with its own
[README](docgen-api/README.md), [OpenAPI specification](docgen-api/openapi.yaml)
and [reference page](docgen-api/docs/api-reference.html). It is deliberately not
a pnpm workspace package.

`docs` is the pnpm workspace. The platform never exposes the API to the browser:
it talks to it from the server, which is what keeps session tokens out of
JavaScript.

## Getting started

Both halves run side by side in development.

The API needs a secret before it will start — there is no default, because a
shared default secret would be worse than none:

```bash
cp docgen-api/.env.example docgen-api/.env
```

Fill in `DOCGEN_JWT_SECRET` with at least 32 bytes, then:

```bash
pnpm docgen:dev
```

And, in a second terminal, the platform:

```bash
pnpm docs:dev
```

## Checks

One command runs everything a change has to pass before it ships:

```bash
pnpm security
```

In order, stopping at the first failure: npm advisories (`pnpm audit`), Go
advisories (`govulncheck`, which reports only what the code can reach),
`gofmt`, `go vet`, the Go tests with the integration suite, the platform's
typecheck, layer rule and tests, and the OpenAPI lint. Tool versions are pinned
in `scripts/security.mjs`, so a result does not depend on the day it ran. It
has been run against a planted vulnerable dependency to confirm it fails.

The halves can also be checked on their own:

```bash
pnpm docgen:test && pnpm docgen:test:integration
```

```bash
pnpm docs:check
```

Vulnerabilities are reported as described in [SECURITY.md](SECURITY.md).

## Deploying

Nothing has been deployed from this repository yet, and one blocker is known —
see the last item. Everything else below is a requirement, not a suggestion:
each one is something the code relies on and cannot check for itself.

**TLS terminates at a proxy.** Neither half speaks HTTPS. Put a
TLS-terminating reverse proxy in front of the platform; the privacy policy
promises encryption in transit, and the platform sends
`Strict-Transport-Security` in production, which is only honest behind one.

**The API stays private.** It listens on `127.0.0.1:8080` by default and
should keep to loopback or a private network that only the platform reaches.
The browser never talks to it. Set `DOCGEN_API_URL` on the platform to wherever
it is.

**Proxy headers are trusted only where they cannot be forged.** Set
`DOCGEN_TRUST_PROXY_HEADERS=true` on the API so its per-IP rate limit sees the
real client address the platform forwards — and only while the API is
unreachable from outside. Anyone who can reach it directly can otherwise write
their own `X-Forwarded-For` and pick which address gets charged. Set
`TRUST_PROXY_HEADERS=true` on the platform when it, in turn, sits behind the
proxy.

**Mail needs a real provider.** `DOCGEN_RESEND_API_KEY` is required: without
it the API refuses to start. `DOCGEN_MAIL_LOG=true` exists for development and
writes every message — password-reset links included — to the log. **Never set
it in production**: whoever reads those logs could take over any account.

**Secrets are generated, never shared.** `DOCGEN_JWT_SECRET` and the platform's
`SESSION_SECRET` need at least 32 random bytes each, different from each other
and from development.

**The public address is set at build time.** `VITE_SITE_URL` is baked into the
bundle — canonical links, Open Graph, the sitemap and `security.txt` all use
it — so set it before `pnpm build`, not only at run time.

**The Origin check needs the real host.** Mutating requests are refused unless
their `Origin` matches the host being served. If the proxy rewrites `Host`,
set `TRUSTED_ORIGIN` to the public origin, for example
`https://docs.imobiliary.com`.

**The controller identity must be real.** The platform refuses to start in
production while `docs/src/domain/legal.ts` still holds placeholders: the
privacy policy, the terms and `security.txt` all name that contact.

**Known blocker: `pnpm start` does not work yet.** It points at
`.output/server/index.mjs`, a path from an older build layout; `vite build`
now produces `dist/`, and its server entry does not listen on its own. The
platform most likely needs a host adapter chosen for wherever it will run.
Settle that before planning a launch.

## A note on names

`docgen` is the internal name and stays that way — the Go module, its packages,
the directory, the configuration prefix. *Imobiliary Docs* is the product name,
and it belongs only to what people see: the platform's interface, its page
titles, its copy.

The two are deliberately not the same thing. A product name answers to
marketing and may change; import paths should never have to follow it. There is
no pending rename here.
