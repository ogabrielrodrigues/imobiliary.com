-- docgen: rebuilds tables
--
-- Templates, documents and batches now belong to an office of the Imobiliary
-- platform, which owns identity (PLANO-FASE-7.md §4). Sign-up, sign-in and
-- password resets leave this service, and with them users, refresh_tokens and
-- password_resets.
--
-- owners holds both kinds of owner. An office appears on its first request.
-- Every account that existed before becomes a legacy owner that keeps its rows
-- until someone of an office signs in with the same e-mail: its templates,
-- documents and batches then move to that office, once.
--
-- SQLite cannot change a foreign key in place, so the three tables are rebuilt
-- with the usual sequence, with foreign keys off (the first line tells the
-- migrator) and checked before the commit.

CREATE TABLE owners (
    id          BLOB PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('organization', 'legacy_account')),
    name        TEXT NOT NULL,
    email       TEXT UNIQUE,
    merged_into BLOB REFERENCES owners (id) ON DELETE SET NULL,
    merged_at   TEXT,
    created_at  TEXT NOT NULL,
    CHECK ((kind = 'legacy_account') = (email IS NOT NULL))
) STRICT;

INSERT INTO owners (id, kind, name, email, created_at)
SELECT id, 'legacy_account', name, email, created_at FROM users;

CREATE TABLE templates_new (
    id             BLOB PRIMARY KEY,
    owner_id       BLOB NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL,
    latest_version INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    deleted_at     TEXT
) STRICT;
INSERT INTO templates_new (id, owner_id, name, description, latest_version, created_at, updated_at, deleted_at)
SELECT id, owner_id, name, description, latest_version, created_at, updated_at, deleted_at FROM templates;
DROP TABLE templates;
ALTER TABLE templates_new RENAME TO templates;
CREATE INDEX idx_templates_owner ON templates (owner_id, id DESC);

CREATE TABLE batches_new (
    id                  BLOB PRIMARY KEY,
    owner_id            BLOB NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    template_id         BLOB NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    template_version_id BLOB NOT NULL REFERENCES template_versions (id) ON DELETE CASCADE,
    template_version    INTEGER NOT NULL,
    name                TEXT NOT NULL,
    created_at          TEXT NOT NULL
) STRICT;
INSERT INTO batches_new (id, owner_id, template_id, template_version_id, template_version, name, created_at)
SELECT id, owner_id, template_id, template_version_id, template_version, name, created_at FROM batches;
DROP TABLE batches;
ALTER TABLE batches_new RENAME TO batches;
CREATE INDEX idx_batches_owner ON batches (owner_id, id DESC);
CREATE INDEX idx_batches_owner_template ON batches (owner_id, template_id, id DESC);

-- reference ties a document to a record elsewhere, such as "contract:<id>",
-- so the platform can list what was generated for it.
CREATE TABLE documents_new (
    id                  BLOB PRIMARY KEY,
    owner_id            BLOB NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
    template_id         BLOB NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    template_version_id BLOB NOT NULL REFERENCES template_versions (id) ON DELETE CASCADE,
    template_version    INTEGER NOT NULL,
    filename            TEXT NOT NULL,
    blob_hash           TEXT NOT NULL,
    size                INTEGER NOT NULL,
    data                TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    batch_id            BLOB REFERENCES batches (id) ON DELETE CASCADE,
    reference           TEXT NOT NULL DEFAULT '' CHECK (length(reference) <= 100)
) STRICT;
INSERT INTO documents_new (id, owner_id, template_id, template_version_id, template_version, filename, blob_hash,
                           size, data, created_at, batch_id)
SELECT id, owner_id, template_id, template_version_id, template_version, filename, blob_hash,
       size, data, created_at, batch_id FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE INDEX idx_documents_owner ON documents (owner_id, id DESC);
CREATE INDEX idx_documents_batch ON documents (batch_id, id DESC);
CREATE INDEX idx_documents_owner_template ON documents (owner_id, template_id, id DESC);
CREATE INDEX idx_documents_owner_reference ON documents (owner_id, reference, id DESC) WHERE reference <> '';

DROP TABLE password_resets;
DROP TABLE refresh_tokens;
DROP TABLE users;
