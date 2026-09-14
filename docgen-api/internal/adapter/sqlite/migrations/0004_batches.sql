-- Batches: documents generated together, from one template version.
--
-- A batch is what lets a history show two hundred documents from a spreadsheet
-- as one collapsible row instead of two hundred loose ones, and download them
-- as one archive. It records the version it was created for, and every document
-- joined to it must have been rendered from that same version, so the batch
-- describes its documents truthfully.
--
-- Deleting an account or a template removes its batches with it, as it does
-- its documents. Deleting a batch removes the documents in it: a batch is how
-- they were made, and they have no life apart from it in the history.
CREATE TABLE batches (
    id                  BLOB PRIMARY KEY,
    owner_id            BLOB NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    template_id         BLOB NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
    template_version_id BLOB NOT NULL REFERENCES template_versions (id) ON DELETE CASCADE,
    template_version    INTEGER NOT NULL,
    name                TEXT NOT NULL,
    created_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_batches_owner ON batches (owner_id, id DESC);
CREATE INDEX idx_batches_owner_template ON batches (owner_id, template_id, id DESC);

-- Nullable: a document generated on its own belongs to no batch. SQLite
-- allows a REFERENCES clause on an added column as long as its default is NULL.
ALTER TABLE documents ADD COLUMN batch_id BLOB REFERENCES batches (id) ON DELETE CASCADE;

CREATE INDEX idx_documents_batch ON documents (batch_id, id DESC);
CREATE INDEX idx_documents_owner_template ON documents (owner_id, template_id, id DESC);
