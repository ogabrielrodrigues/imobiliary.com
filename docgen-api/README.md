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

Two direct dependencies, each with a reason:

| Dependency | Why it is not the standard library |
|---|---|
| `modernc.org/sqlite` | Pure-Go SQLite, no cgo, so the binary links statically |
| `github.com/golang-jwt/jwt/v5` | Verifying the Imobiliary platform's Ed25519 tokens |

Everything else — HTTP, routing, ZIP, XML, JSON, UUID, HMAC, randomness — comes
from the standard library, including the `uuid` package and `encoding/json/v2`
that became stable in Go 1.27.

## Running

Every command below runs from this directory, `docgen-api/`. From the
repository root, `pnpm docgen:dev` and the other `docgen:*` scripts do the same thing.

```sh
# The platform's public keys, printed by `imobiliary public-keys` there.
export DOCGEN_IDENTITY_PUBLIC_KEYS="1:BASE64_OF_32_BYTES"
go run ./cmd/docgen
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DOCGEN_IDENTITY_PUBLIC_KEYS` | *required* | The Imobiliary platform's token verification keys, `name:base64,…` |
| `DOCGEN_ADDR` | `127.0.0.1:8080` | Listen address. Loopback on purpose: the API should be reachable only by the platform |
| `DOCGEN_DB_PATH` | `data/docgen.db` | SQLite file |
| `DOCGEN_BLOB_DIR` | `data/blobs` | Document storage directory |
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
| `GET` | `/v1/me` | token | The member, the office and the role |
| `POST` | `/v1/templates` | token | Upload a template (multipart: `name`, `description`, `file`) |
| `GET` | `/v1/templates` | token | List templates |
| `GET` | `/v1/templates/{id}` | token | Template and its placeholder schema |
| `POST` | `/v1/templates/{id}/versions` | token | Publish a new version |
| `GET` | `/v1/templates/{id}/versions/{version}/file` | token | Download a version's `.docx` |
| `DELETE` | `/v1/templates/{id}` | token | Remove a template |
| `POST` | `/v1/documents` | token | Generate a document, optionally with a `reference` |
| `GET` | `/v1/documents` | token | List documents (`?reference=` for one record's) |
| `GET` | `/v1/documents/{id}` | token | Document metadata |
| `GET` | `/v1/documents/{id}/download` | token | Download the `.docx` |
| `GET` | `/healthz` | — | Liveness |

### Example

```sh
# A token for this service, from a signed-in session on the platform.
ACCESS_TOKEN=$(curl -s -X POST localhost:8081/v1/sessions/docgen-token \
  -H "Authorization: Bearer $PLATFORM_ACCESS_TOKEN" | jq -r .token)

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

- **Identity.** Accounts, passwords, second factors and sessions live on the
  Imobiliary platform. This service verifies the platform's five-minute
  Ed25519 tokens (issuer `imobiliary`, audience `docgen`, key by `kid`) with
  public keys only, so it holds nothing that could mint one. HS256 and `none`
  are refused. The old account routes answer `410`.
- **Ownership.** Templates, documents and batches belong to the office in the
  token. An account from before identity moved keeps its rows until a member of
  an office signs in with its e-mail; they then move to that office, once.
- **Rate limiting.** Layered in-memory token buckets: a global per-IP limit, and
  a per-office limit on uploading and generating.
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
internal/platform   config, token verification, rate limiting, blob storage
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
