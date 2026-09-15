# imobiliary-api

The rental management API of Imobiliary: people, properties, contracts,
amendments and rents, for organisations of brokers and small agencies. Go 1.27
and PostgreSQL 18.

The implementation plan, with every decision behind the data model, is
[`PLANO.md`](../PLANO.md) at the repository root.

## Dependencies

| Module | Why |
|---|---|
| `github.com/jackc/pgx/v5` | The standard library has no PostgreSQL driver. pgx also reports errors with their SQLSTATE, so a constraint violation is recognised by code rather than by matching message text. |

Everything else is the standard library, including `uuid` for UUIDv7
identifiers, `encoding/json/v2`, AES-GCM and HMAC for field encryption, and
`log/slog`.

## Layout

```
cmd/imobiliary/          entry point: serve and migrate
internal/domain/         value types and rules; imports nothing else of ours
internal/usecase/        use cases and the ports they consume
internal/adapter/http/   net/http server, middleware, responses
internal/adapter/postgres/ pool, migrator, repositories, migrations/*.sql
internal/platform/       config, fieldcrypt, logging, metrics, pgtest
scripts/setup-local.sql  roles and database for development
```

## Running locally

1. Install PostgreSQL 18 (on Windows, `winget install PostgreSQL.PostgreSQL.18`).
2. Create the roles and the database, as the superuser. The script asks for
   each role's password:

   ```sh
   psql -U postgres -f imobiliary-api/scripts/setup-local.sql
   ```

3. Put the passwords in `%APPDATA%\postgresql\pgpass.conf` (`~/.pgpass`
   elsewhere), never in `.env`. The test role connects to databases created
   per test, so its line uses `*` for the database:

   ```
   localhost:5432:imobiliary:imobiliary_owner:<password>
   localhost:5432:imobiliary:imobiliary_app:<password>
   localhost:5432:*:imobiliary_test:<password>
   ```

4. `cp .env.example .env` and generate the two keys it asks for.
5. From the repository root:

   ```sh
   pnpm imobiliary:migrate
   pnpm imobiliary:dev
   ```

The API listens on `127.0.0.1:8081`, metrics on `127.0.0.1:9181/metrics`.

## Commands

`imobiliary serve` runs the API. It connects as `imobiliary_app`, which owns no
table and cannot change the schema, and refuses to start while a migration is
pending or when the database holds one this build does not know.

`imobiliary migrate` applies pending migrations as `imobiliary_owner`. It holds
an advisory lock, so two instances deploying together apply each migration
once. A migration already applied is never edited: its checksum is recorded,
and both commands refuse a database whose history no longer matches the
embedded files.

## Endpoints so far

| Route | Purpose |
|---|---|
| `GET /healthz` | Liveness: the process answers. Never checks the database, so a database outage does not restart a healthy process. |
| `GET /readyz` | Readiness: the database answers within 2 seconds. The failure reason is logged, never returned. |
| `GET /metrics` | Prometheus text format, on the metrics listener only. |

Every response carries a generated `X-Request-ID`, `Cache-Control: no-store`
and `X-Content-Type-Options: nosniff`. Unknown routes answer a JSON 404.

## Observability

- **Logs** are JSON lines on stdout, collected as they are by the Datadog
  Agent or Grafana Alloy. One line per request, with the route pattern (never
  the path, which carries identifiers), status, duration, client address and,
  when the platform sends a W3C `traceparent`, its trace id. Attributes whose
  names mention credentials or personal data are redacted.
- **Metrics**: `imobiliary_http_requests_total{method,route,status}` and
  `imobiliary_http_request_duration_seconds{method,route}`. Unknown paths
  share one `unmatched` label, so probes for random URLs cannot create series.

## Personal data at rest

`internal/platform/fieldcrypt` seals fields with AES-256-GCM under versioned
keys (`IMOBILIARY_FIELD_KEYS`). The table, column and row are authenticated
with each value, so a ciphertext moved to another row fails to open. Exact
lookups on a sealed field use an HMAC blind index scoped to the organisation
(`IMOBILIARY_INDEX_KEY`). That key cannot be rotated without recomputing every
index.

## Checks

```sh
gofmt -l . && go vet ./... && go vet -tags=integration ./...
go test ./...
go test -tags=integration ./...
```

Integration tests need `IMOBILIARY_TEST_DATABASE_URL`. `internal/platform/pgtest`
migrates a template database once per set of migrations and gives each test a
copy of its own, dropped afterwards.

Fuzz targets live next to the value types:

```sh
go test ./internal/domain -run '^$' -fuzz FuzzNormalizeCNPJ -fuzztime 30s
```
