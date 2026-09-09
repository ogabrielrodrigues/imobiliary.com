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
pnpm api:dev
```

And, in a second terminal, the platform:

```bash
pnpm dev
```

## Checks

```bash
pnpm api:test && pnpm api:test:integration
```

```bash
pnpm typecheck && pnpm test
```

## A note on names

The API is still called `docgen` in code. The product name is *Imobiliary Docs*;
renaming the Go module is a cosmetic change worth doing on its own, not mixed
into feature work.
