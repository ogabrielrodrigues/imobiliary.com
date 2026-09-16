-- Erasing an account without erasing what the law says must be kept.
--
-- Deleting a user used to set access_records.user_id to null, which kept the
-- address and the instant but made the record answer nothing: a court asking
-- who used the application from an address would get an empty name. The
-- Marco Civil (art. 15) obliges six months of records, and the LGPD (art. 16,
-- I) allows keeping personal data to meet a legal obligation, so both rows are
-- kept, and for no longer than that.

-- The identifier stays on the record after the account is gone. Without a
-- foreign key it points at nothing in users, and at closed_accounts instead.
ALTER TABLE access_records DROP CONSTRAINT access_records_user_id_fkey;

-- What remains of a deleted account: the address that identified it, sealed
-- with the field key against this row, and the instant it was closed. Nothing
-- else. Purged with the access records it serves, six months after closing.
CREATE TABLE closed_accounts (
	user_id   uuid        PRIMARY KEY,
	email     bytea       NOT NULL,
	closed_at timestamptz NOT NULL
);

CREATE INDEX closed_accounts_closed_idx ON closed_accounts (closed_at);

-- Kept, not edited. A closed account is only ever inserted and, when its
-- time is up, purged.
REVOKE UPDATE ON closed_accounts FROM imobiliary_app;
