-- Two records that are not the operational log, and not each other.
--
-- audit_events answers "who changed what, and when" for the office's own data.
-- access_records answers the single question the Marco Civil da Internet
-- (art. 15) obliges an application provider to be able to answer: who used the
-- application from which address, at what time. They are kept apart because
-- they have different purposes, different retention and different readers.

CREATE TABLE audit_events (
	id              uuid        PRIMARY KEY,
	-- Null for what happens outside any organisation, such as a password
	-- reset from a mailed link.
	organization_id uuid        REFERENCES organizations (id) ON DELETE SET NULL,
	-- The trail outlives the account it describes: erasing a person must not
	-- erase the evidence that something was done. Set null rather than
	-- cascade, so the row survives without naming anyone.
	actor_id        uuid        REFERENCES users (id) ON DELETE SET NULL,
	action          text        NOT NULL,
	entity_type     text        NOT NULL,
	entity_id       uuid,
	-- Which fields changed, never their values: a changed CPF must leave a
	-- trace without the trail becoming a second, unencrypted copy of the data.
	fields          text[]      NOT NULL DEFAULT '{}',
	request_id      text        NOT NULL DEFAULT '',
	ip              inet,
	occurred_at     timestamptz NOT NULL
);

CREATE INDEX audit_events_organization_idx ON audit_events (organization_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, occurred_at DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, occurred_at DESC);

-- Append-only, enforced by the database rather than by good intentions: the
-- service may write and read the trail, and cannot rewrite it. Fixing a wrong
-- entry means writing the next one.
REVOKE UPDATE, DELETE ON audit_events FROM imobiliary_app;

CREATE TABLE access_records (
	id          uuid        PRIMARY KEY,
	-- Null when the attempt named no account that exists.
	user_id     uuid        REFERENCES users (id) ON DELETE SET NULL,
	event       text        NOT NULL,
	ip          inet,
	-- The source port matters: behind carrier-grade NAT an address alone
	-- identifies thousands of subscribers, which is why courts ask for the
	-- port as well.
	port        integer     NOT NULL DEFAULT 0,
	occurred_at timestamptz NOT NULL
);

-- Both the purge and any lawful request read by time.
CREATE INDEX access_records_occurred_idx ON access_records (occurred_at);
CREATE INDEX access_records_user_idx ON access_records (user_id, occurred_at DESC);

-- Not partitioned, on purpose. An office signs in a few dozen times a day, so
-- six months is thousands of rows, and a monthly DELETE costs nothing at that
-- size. Partitioning would buy a faster purge and cost a partition to create
-- every month, by a role that is not allowed to create tables.
