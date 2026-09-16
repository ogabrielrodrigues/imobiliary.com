-- Identity: organisations, accounts, memberships, sessions and the ways in.
--
-- Row-level security is deliberately absent from these tables. It guards the
-- business data, where every row belongs to an organisation and every query
-- runs inside an organisation-scoped transaction. Signing in happens before
-- any organisation is known, so a policy here would have to be disabled for
-- exactly the requests it was meant to guard.

CREATE TABLE organizations (
	id         uuid        PRIMARY KEY,
	name       text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL
);

CREATE TABLE users (
	id            uuid        PRIMARY KEY,
	-- Stored already normalised, and the constraint says so: two accounts
	-- differing only in case are the same account to everyone but a database.
	email         text        NOT NULL UNIQUE CHECK (email = lower(email)),
	name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
	password_hash text        NOT NULL,
	-- An access token minted before this instant belongs to a credential that
	-- no longer exists; Authenticate compares the two.
	password_changed_at timestamptz,
	terms_accepted_at   timestamptz,
	terms_version       text    NOT NULL DEFAULT '',
	-- Set only once a code from the enrolment has been proved, so a mistyped
	-- setup cannot lock an account out.
	totp_confirmed_at   timestamptz,
	created_at    timestamptz NOT NULL,
	updated_at    timestamptz NOT NULL
);

CREATE TABLE memberships (
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
	user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	role            text        NOT NULL CHECK (role IN ('admin', 'member')),
	created_at      timestamptz NOT NULL,
	updated_at      timestamptz NOT NULL,
	PRIMARY KEY (organization_id, user_id)
);

-- "Which organisations does this person belong to" is asked on every sign-in.
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- A session belongs to one account working in one organisation. Someone who
-- belongs to two offices holds two sessions, so switching is deliberate rather
-- than ambient.
CREATE TABLE refresh_tokens (
	id              uuid        PRIMARY KEY,
	user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
	-- Only the digest is stored, so a leaked database hands out no sessions.
	token_hash      bytea       NOT NULL UNIQUE,
	-- The token this one replaced, which is what makes a chain visible.
	parent_id       uuid        REFERENCES refresh_tokens (id) ON DELETE SET NULL,
	expires_at      timestamptz NOT NULL,
	created_at      timestamptz NOT NULL,
	used_at         timestamptz,
	revoked_at      timestamptz
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
-- The sweep that removes tokens nobody can use any more.
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

CREATE TABLE password_resets (
	id         uuid        PRIMARY KEY,
	user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	token_hash bytea       NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL,
	used_at    timestamptz
);

CREATE INDEX password_resets_user_idx ON password_resets (user_id);
CREATE INDEX password_resets_expires_idx ON password_resets (expires_at);

-- How someone joins an office: an admin invites an address, and the link
-- carries a secret whose digest alone is stored.
CREATE TABLE invitations (
	id              uuid        PRIMARY KEY,
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
	email           text        NOT NULL CHECK (email = lower(email)),
	role            text        NOT NULL CHECK (role IN ('admin', 'member')),
	token_hash      bytea       NOT NULL UNIQUE,
	invited_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
	expires_at      timestamptz NOT NULL,
	created_at      timestamptz NOT NULL,
	accepted_at     timestamptz,
	revoked_at      timestamptz
);

-- One invitation outstanding per address per organisation. Inviting the same
-- person twice is answered with the existing invitation rather than a second
-- link that makes the first one's fate unclear.
CREATE UNIQUE INDEX invitations_pending_key
	ON invitations (organization_id, email)
	WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX invitations_organization_idx ON invitations (organization_id, created_at DESC);

-- The second factor. The secret is sealed with the field key, like any other
-- personal datum, and opened only to verify a code.
CREATE TABLE user_totp (
	user_id        uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	secret         bytea       NOT NULL,
	-- The time step of the last accepted code, so one seen over a shoulder
	-- cannot be replayed inside its own window.
	last_used_step bigint      NOT NULL DEFAULT 0,
	created_at     timestamptz NOT NULL,
	confirmed_at   timestamptz
);

CREATE TABLE recovery_codes (
	id        uuid  PRIMARY KEY,
	user_id   uuid  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	code_hash bytea NOT NULL,
	used_at   timestamptz
);

CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id);

-- The short-lived proof that a password was accepted and only the second
-- factor is missing. A row rather than only a signed token, so that it can be
-- spent: one attempt, and a captured challenge is useless afterwards.
CREATE TABLE mfa_challenges (
	id         uuid        PRIMARY KEY,
	user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	token_hash bytea       NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL,
	used_at    timestamptz
);

CREATE INDEX mfa_challenges_expires_idx ON mfa_challenges (expires_at);
