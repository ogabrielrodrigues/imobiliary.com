# docgen

An API that generates standardised DOCX documents from user-uploaded templates.

Upload a `.docx` containing `{{.placeholder}}` markers, and the service discovers
the placeholder schema for you, renders documents against it, and serves the
result for download.

## Design in one paragraph

A `.docx` is a ZIP archive of XML. That makes the whole rendering engine
buildable from `archive/zip`, `encoding/xml` and `text/template`, with no OOXML
library involved. Metadata lives in an embedded SQLite database and rendered
documents live on disk under their content hash, so the service deploys as a
single binary with no database server, no queue and no object store.

## Requirements

Go 1.27.1 or newer. The module pins that version, so `GOTOOLCHAIN=auto` (the
default) downloads it automatically.

Three direct dependencies, each with a reason:

| Dependency | Why it is not the standard library |
|---|---|
| `modernc.org/sqlite` | Pure-Go SQLite, no cgo, so the binary links statically |
| `github.com/golang-jwt/jwt/v5` | JWT signing and validation |
| `golang.org/x/crypto` | argon2id; the standard library has no password KDF |

Everything else — HTTP, routing, ZIP, XML, JSON, UUID, HMAC, randomness — comes
from the standard library, including the `uuid` package and `encoding/json/v2`
that became stable in Go 1.27.

## Running

Every command below runs from this directory, `docgen-api/`. From the
repository root, `pnpm api:dev` and the other `api:*` scripts do the same thing.

```sh
export DOCGEN_JWT_SECRET="at-least-32-bytes-of-secret-material"
go run ./cmd/docgen
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DOCGEN_JWT_SECRET` | *required* | HMAC key, at least 32 bytes |
| `DOCGEN_ADDR` | `:8080` | Listen address |
| `DOCGEN_DB_PATH` | `data/docgen.db` | SQLite file |
| `DOCGEN_BLOB_DIR` | `data/blobs` | Document storage directory |
| `DOCGEN_ACCESS_TTL` | `15m` | Access token lifetime |
| `DOCGEN_REFRESH_TTL` | `720h` | Refresh token lifetime |
| `DOCGEN_MAX_TEMPLATE_BYTES` | `10485760` | Upload size limit |
| `DOCGEN_MAX_REQUEST_BYTES` | `1048576` | JSON body size limit |
| `DOCGEN_TRUST_PROXY_HEADERS` | `false` | Read the client IP from `X-Forwarded-For` |

Leave `DOCGEN_TRUST_PROXY_HEADERS` off unless a trusted proxy sets the header.
Honouring it otherwise would let any client choose its own rate-limit key.

## Writing a template

Put placeholders in the document body, header or footer:

```
Dear {{.customer_name}},

Your plan is {{.plan}} at {{.amount}} per month.
```

Names must be lowercase `snake_case`. It does not matter if Word has split a
placeholder across several runs — a normalisation pass reassembles it when the
template version is created.

The accepted grammar is deliberately narrow: a placeholder is a bare field
reference and nothing else. Pipelines, function calls, variables, conditionals
and loops are rejected with an explanatory error, because the template is
untrusted input and this is all the feature needs.

## API

The full contract lives in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1), which is
the source of truth for request and response shapes. For poking at a running
instance, [`docgen.postman_collection.json`](docgen.postman_collection.json)
imports into HTTPie Desktop, Postman or Insomnia.

The table below is a map; the specification has the detail.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/auth/register` | — | Create an account |
| `POST` | `/v1/auth/login` | — | Exchange credentials for a session |
| `POST` | `/v1/auth/refresh` | refresh | Rotate the token pair |
| `POST` | `/v1/auth/logout` | refresh | End the session |
| `GET` | `/v1/me` | access | Current account |
| `POST` | `/v1/templates` | access | Upload a template (multipart: `name`, `description`, `file`) |
| `GET` | `/v1/templates` | access | List templates |
| `GET` | `/v1/templates/{id}` | access | Template and its placeholder schema |
| `POST` | `/v1/templates/{id}/versions` | access | Publish a new version |
| `GET` | `/v1/templates/{id}/versions/{version}/file` | access | Download a version's `.docx` |
| `DELETE` | `/v1/templates/{id}` | access | Remove a template |
| `POST` | `/v1/documents` | access | Generate a document |
| `GET` | `/v1/documents` | access | List documents |
| `GET` | `/v1/documents/{id}` | access | Document metadata |
| `GET` | `/v1/documents/{id}/download` | access | Download the `.docx` |
| `GET` | `/healthz` | — | Liveness |

### Example

```sh
# Authenticate.
curl -X POST localhost:8080/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"someone@example.com","password":"a-sufficiently-long-password"}'

# Upload a template. The response reports the placeholders found in it.
curl -X POST localhost:8080/v1/templates \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F 'name=Service agreement' \
  -F 'file=@agreement.docx'

# Generate a document, then download it.
curl -X POST localhost:8080/v1/documents \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"template_id":"...","data":{"customer_name":"Acme","plan":"Premium"}}'

curl -OJ localhost:8080/v1/documents/$ID/download \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

Every failure uses the same shape, so a client needs one error path:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "the request could not be processed",
    "fields": [{"field": "data.amount", "message": "is required by the template"}]
  }
}
```

## Security

- **Sessions.** A short-lived HS256 access token is validated without touching
  the database. The refresh token is opaque, stored only as a SHA-256 digest,
  and rotated on every use. Presenting an already-consumed refresh token means
  two parties hold it, so every session of that account is revoked.
- **Passwords.** argon2id at the OWASP baseline (m=19456, t=2, p=1). The cost
  parameters are stored alongside each hash, so they can be raised later without
  invalidating existing accounts.
- **Rate limiting.** Layered in-memory token buckets: a global per-IP limit, a
  strict per-IP limit on the credential endpoints, and a per-account limit on
  uploading and generating.
- **Uploads.** Archives are checked for entry count, expanded size and unsafe
  entry names before anything is parsed. `encoding/xml` does not resolve
  external entities, which rules out XXE.
- **Output.** Substituted values are XML-escaped, so a value containing `&` or
  `<` cannot corrupt the document or inject markup.
- **Ownership.** Every repository query filters by owner, so a handler cannot
  forget to check.

## Layout

```
cmd/docgen          composition root
internal/domain     entities and rules; imports nothing from this module
internal/usecase    operations, and the interfaces they depend on
internal/adapter    http, sqlite and docx implementations
internal/platform   config, tokens, passwords, rate limiting, blob storage
```

Dependencies point inwards: `adapter` → `usecase` → `domain`. Interfaces are
declared in `usecase`, next to the code that consumes them rather than the code
that implements them, which is what lets the adapters plug in without the inner
layers knowing they exist.

## Tests

```sh
go test ./...                     # unit tests
go test -tags=integration ./...   # adds SQLite and end-to-end HTTP tests
go vet ./...
```

Unit tests use hand-written fakes and an injected clock, so nothing sleeps.
Integration tests run against a real SQLite file and a real HTTP server,
covering the full path from registration to downloading a document and reopening
it as an archive.
