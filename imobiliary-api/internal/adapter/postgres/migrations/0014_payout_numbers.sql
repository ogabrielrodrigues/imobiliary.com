-- A payout's number is never used twice, even after the payout is undone: a
-- receipt with that number may already be printed and signed. The number came
-- from the highest existing one, so undoing the last payout freed its number
-- for the next. This counter only goes up.
CREATE TABLE payout_numbers (
	organization_id uuid    NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	year            integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
	last_sequence   integer NOT NULL CHECK (last_sequence > 0),
	PRIMARY KEY (organization_id, year)
);

-- Offices that already recorded payouts continue from their highest number.
INSERT INTO payout_numbers (organization_id, year, last_sequence)
SELECT organization_id, year, max(sequence) FROM payouts GROUP BY organization_id, year;

ALTER TABLE payout_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_numbers FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON payout_numbers
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
