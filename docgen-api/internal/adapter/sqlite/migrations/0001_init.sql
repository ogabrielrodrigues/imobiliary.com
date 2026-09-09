-- Identifiers are UUIDv7 stored as 16-byte blobs. Being time-ordered, they keep
-- inserts local at the right edge of each B-tree index instead of scattering
-- writes the way a random UUIDv4 primary key does.
--
-- Timestamps are RFC 3339 strings in UTC: lexicographically sortable, and
-- legible when inspecting the database by hand.
--
-- Every table is STRICT, so SQLite enforces the declared column types instead
-- of applying its usual type affinity rules.

CREATE TABLE users (
    id            BLOB PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
) STRICT;

-- A refresh token is one link in a session chain: each exchange consumes a
-- token and mints a successor pointing back at it. Only the digest of the
-- secret is stored, so a database leak yields no usable sessions.
CREATE TABLE refresh_tokens (
    id         BLOB PRIMARY KEY,
    user_id    BLOB NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash BLOB NOT NULL UNIQUE,
    parent_id  BLOB REFERENCES refresh_tokens (id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at    TEXT,
    revoked_at TEXT
) STRICT;

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);

CREATE TABLE templates (
    id             BLOB PRIMARY KEY,
    owner_id       BLOB NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL,
    latest_version INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT
) STRICT;

CREATE INDEX idx_templates_owner ON templates (owner_id, id DESC);

-- Versions are append-only: publishing a change inserts a new row rather than
-- updating an existing one. That immutability is what lets a compiled template
-- be cached in memory for the lifetime of the process, and what makes every
-- generated document reproducible.
CREATE TABLE template_versions (
    id           BLOB PRIMARY KEY,
    template_id  BLOB NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    blob_hash    TEXT NOT NULL,
    size         INTEGER NOT NULL,
    placeholders TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (template_id, version)
) STRICT;

CREATE TABLE documents (
    id                  BLOB PRIMARY KEY,
    owner_id            BLOB NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    template_id         BLOB NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    template_version_id BLOB NOT NULL REFERENCES template_versions (id) ON DELETE CASCADE,
    template_version    INTEGER NOT NULL,
    filename            TEXT NOT NULL,
    blob_hash           TEXT NOT NULL,
    size                INTEGER NOT NULL,
    data                TEXT NOT NULL,
    created_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_documents_owner ON documents (owner_id, id DESC);
