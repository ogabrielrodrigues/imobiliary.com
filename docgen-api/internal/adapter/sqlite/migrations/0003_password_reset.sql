-- Password changes, and the one-time tokens that authorise a reset.
--
-- password_changed_at exists because an access token is stateless: revoking a
-- session does not reach one already in circulation, so without an instant to
-- compare against, changing a password would leave every token minted before
-- it valid until it expired on its own. It is nullable, because an account
-- that has never changed its password has not, and writing its creation time
-- here would be inventing an event.
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

-- A reset token is a single-use permission to set a new password without
-- knowing the old one, which makes it worth as much as the password itself.
-- So, like a refresh token, only the digest of the secret is stored: a leak of
-- this table hands out nothing usable.
--
-- used_at records consumption rather than deleting the row, so a second
-- presentation of the same token can be told apart from one that never
-- existed. Expired and consumed rows are swept by the same hourly job that
-- clears refresh tokens.
CREATE TABLE password_resets (
    id         BLOB PRIMARY KEY,
    user_id    BLOB NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash BLOB NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at    TEXT
) STRICT;

CREATE INDEX idx_password_resets_user ON password_resets (user_id);
