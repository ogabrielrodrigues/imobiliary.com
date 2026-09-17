-- Rent adjustments (PLANO.md §3.7). Each one changes the rent from a day on:
-- contracts.current_rent and the unpaid instalments whose month starts on or
-- after that day, in the same transaction. The rate is kept for reference;
-- indexed_rent is the rent agreed, which may differ from the suggestion.
CREATE TABLE amendments (
	id                     uuid        PRIMARY KEY,
	organization_id        uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	contract_id            uuid        NOT NULL,
	amended_on             date        NOT NULL,
	adjustment_index       text        NOT NULL CHECK (adjustment_index IN
		('', 'igpm', 'ipca', 'inpc', 'ivar', 'igpdi')),
	index_rate             integer     NOT NULL CHECK (index_rate > -1000000 AND index_rate <= 1000000),
	previous_rent          bigint      NOT NULL CHECK (previous_rent > 0),
	indexed_rent           bigint      NOT NULL CHECK (indexed_rent > 0),
	-- The acknowledgement of the adjustment_period notice, when it was raised.
	period_acknowledged_by uuid        REFERENCES users (id) ON DELETE SET NULL,
	period_acknowledged_at timestamptz,
	created_at             timestamptz NOT NULL,
	UNIQUE (organization_id, id),
	UNIQUE (contract_id, amended_on),
	FOREIGN KEY (organization_id, contract_id)
		REFERENCES contracts (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX amendments_contract_idx ON amendments (contract_id, amended_on);

ALTER TABLE amendments ENABLE ROW LEVEL SECURITY;
ALTER TABLE amendments FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON amendments
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
