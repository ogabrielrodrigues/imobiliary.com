-- Charges billed with a rent besides the rent itself (PLANO.md §3.8), and what
-- the payment screens and the dashboard read.

ALTER TABLE rents ADD CONSTRAINT rents_organization_id_id_key UNIQUE (organization_id, id);

CREATE TABLE rent_charges (
	id              uuid        PRIMARY KEY,
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	rent_id         uuid        NOT NULL,
	kind            text        NOT NULL CHECK (kind IN ('condominium', 'property_tax', 'water', 'energy', 'other')),
	description     text        NOT NULL DEFAULT '' CHECK (length(description) <= 120),
	amount          bigint      NOT NULL CHECK (amount > 0),
	created_at      timestamptz NOT NULL,
	FOREIGN KEY (organization_id, rent_id)
		REFERENCES rents (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX rent_charges_rent_idx ON rent_charges (rent_id, created_at);

-- "What came in this month", the dashboard's receipts.
CREATE INDEX rents_paid_idx ON rents (organization_id, paid_on) WHERE paid_on IS NOT NULL;
-- Rents by due day across contracts, the list at /alugueis.
CREATE INDEX rents_due_idx ON rents (organization_id, due_on, id);

ALTER TABLE rent_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE rent_charges FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON rent_charges
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
