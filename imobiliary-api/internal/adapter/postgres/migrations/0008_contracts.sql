-- Contracts, their parties, the legal notices acknowledged, and the rent
-- instalments generated from them.
--
-- Same guarantees as 0005 and 0006: organization_id with a forced policy,
-- composite foreign keys inside the office, RESTRICT to the office. A property
-- or a person a contract names cannot be deleted while it does.

CREATE TABLE contracts (
	id                 uuid        PRIMARY KEY,
	organization_id    uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	property_id        uuid        NOT NULL,
	registry           text        NOT NULL CHECK (length(registry) BETWEEN 1 AND 60),
	guarantee_kind     text        NOT NULL CHECK (guarantee_kind IN
		('none', 'deposit', 'surety', 'surety_insurance', 'fund_assignment')),
	-- Centavos. Only a deposit has an amount: art. 37 allows one guarantee.
	deposit_amount     bigint      NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
	rent               bigint      NOT NULL CHECK (rent > 0),
	current_rent       bigint      NOT NULL CHECK (current_rent > 0),
	-- Rates in millionths.
	admin_fee          integer     NOT NULL DEFAULT 100000 CHECK (admin_fee BETWEEN 0 AND 1000000),
	late_penalty_rate  integer     NOT NULL CHECK (late_penalty_rate BETWEEN 0 AND 1000000),
	late_interest_rate integer     NOT NULL CHECK (late_interest_rate BETWEEN 0 AND 1000000),
	due_day            smallint    NOT NULL CHECK (due_day BETWEEN 1 AND 31),
	adjustment_index   text        NOT NULL DEFAULT '' CHECK (adjustment_index IN
		('', 'igpm', 'ipca', 'inpc', 'ivar', 'igpdi')),
	signed_on          date        NOT NULL,
	starts_on          date        NOT NULL,
	expires_on         date        NOT NULL,
	terminated_on      date,
	version            integer     NOT NULL DEFAULT 1,
	created_at         timestamptz NOT NULL,
	updated_at         timestamptz NOT NULL,
	UNIQUE (organization_id, id),
	UNIQUE (organization_id, registry),
	FOREIGN KEY (organization_id, property_id)
		REFERENCES properties (organization_id, id) ON DELETE RESTRICT,
	CHECK (expires_on > starts_on),
	CHECK (terminated_on IS NULL OR terminated_on BETWEEN starts_on AND expires_on),
	CHECK ((guarantee_kind = 'deposit') = (deposit_amount > 0)),
	-- One lease of a property at a time, enforced by the database: two
	-- contracts whose periods overlap on the same property cannot both be
	-- stored, however they arrive. A terminated contract's period ends on the
	-- termination day. Inclusive at both ends, so the next lease starts the day
	-- after.
	CONSTRAINT contracts_one_lease_per_property EXCLUDE USING gist (
		property_id WITH =,
		daterange(starts_on, COALESCE(terminated_on, expires_on), '[]') WITH &&
	)
);

CREATE INDEX contracts_order_idx ON contracts (organization_id, starts_on DESC, id DESC);
CREATE INDEX contracts_property_idx ON contracts (property_id);

CREATE TABLE contract_parties (
	organization_id uuid    NOT NULL,
	contract_id     uuid    NOT NULL,
	person_id       uuid    NOT NULL,
	role            text    NOT NULL CHECK (role IN ('landlord', 'tenant', 'guarantor', 'guarantor_spouse')),
	position        integer NOT NULL,
	PRIMARY KEY (contract_id, person_id, role),
	FOREIGN KEY (organization_id, contract_id)
		REFERENCES contracts (organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, person_id)
		REFERENCES people (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX contract_parties_person_idx ON contract_parties (person_id);

-- Who acknowledged which legal notice, and when. Kept with the contract: the
-- record is the point of the notice.
CREATE TABLE contract_acknowledgments (
	organization_id uuid        NOT NULL,
	contract_id     uuid        NOT NULL,
	code            text        NOT NULL CHECK (code IN ('advance_rent', 'guarantor_spouse_consent', 'deposit_limit')),
	acknowledged_by uuid        REFERENCES users (id) ON DELETE SET NULL,
	acknowledged_at timestamptz NOT NULL,
	PRIMARY KEY (contract_id, code),
	FOREIGN KEY (organization_id, contract_id)
		REFERENCES contracts (organization_id, id) ON DELETE CASCADE
);

-- The instalments. Payment columns exist now so the deletion rule can read
-- them; recording payments is phase 6.
CREATE TABLE rents (
	id              uuid    PRIMARY KEY,
	organization_id uuid    NOT NULL,
	contract_id     uuid    NOT NULL,
	sequence        integer NOT NULL CHECK (sequence > 0),
	due_on          date    NOT NULL,
	rent_amount     bigint  NOT NULL CHECK (rent_amount > 0),
	late_fee        bigint  NOT NULL DEFAULT 0 CHECK (late_fee >= 0),
	amount_paid     bigint  CHECK (amount_paid >= 0),
	paid_on         date,
	UNIQUE (contract_id, sequence),
	UNIQUE (contract_id, due_on),
	CHECK ((paid_on IS NULL) = (amount_paid IS NULL)),
	FOREIGN KEY (organization_id, contract_id)
		REFERENCES contracts (organization_id, id) ON DELETE CASCADE
);

-- "What is due and unpaid", the question the dashboard asks every day.
CREATE INDEX rents_pending_idx ON rents (organization_id, due_on) WHERE paid_on IS NULL;

ALTER TABLE contracts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_parties         ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_acknowledgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rents                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts                FORCE ROW LEVEL SECURITY;
ALTER TABLE contract_parties         FORCE ROW LEVEL SECURITY;
ALTER TABLE contract_acknowledgments FORCE ROW LEVEL SECURITY;
ALTER TABLE rents                    FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON contracts
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON contract_parties
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON contract_acknowledgments
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON rents
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
