-- Payouts to owners (PLANO-REPASSE.md): who administers, where each charge
-- goes, the income tax a company tenant withholds, the landlords' shares when
-- they are not the property's owners, and the ledger with its payouts.

-- The office as the administrator the receipts name. The document is a CPF
-- for a self-employed broker, which is personal data, so it is sealed like a
-- person's (table organizations, column administrator_document, row = id).
ALTER TABLE organizations
	ADD COLUMN administrator_kind     text CHECK (administrator_kind IN ('individual', 'company')),
	ADD COLUMN administrator_document text,
	ADD COLUMN administrator_creci    text NOT NULL DEFAULT '' CHECK (length(administrator_creci) <= 30);

-- Where a charge's money goes. Charges recorded before this default to a third
-- party: that creates no debt to an owner the office never acknowledged, and a
-- paid rent's charge can still change destination while none of its lines is
-- in a payout.
ALTER TABLE rent_charges
	ADD COLUMN destination text NOT NULL DEFAULT 'third_party'
		CHECK (destination IN ('owner', 'third_party'));

-- Income tax withheld by a company tenant: the rent counts as paid in full,
-- the payout deducts it.
ALTER TABLE rents
	ADD COLUMN income_tax_withheld bigint NOT NULL DEFAULT 0
		CHECK (income_tax_withheld >= 0 AND income_tax_withheld <= rent_amount);

-- A landlord's share, only when the landlords are not exactly the property's
-- owners (a usufructuary, one co-owner leasing alone). Otherwise the property's
-- shares on the day a rent is received decide.
ALTER TABLE contract_parties
	ADD COLUMN share integer CHECK (share > 0 AND share <= 1000000),
	ADD CONSTRAINT contract_parties_share_landlord CHECK (share IS NULL OR role = 'landlord');

-- Contracts that already exist with landlords who are not the owners get an
-- even split, the remainder on the last landlord, as the property screen does.
WITH landlords AS (
	SELECT cp.contract_id, cp.person_id,
	       row_number() OVER (PARTITION BY cp.contract_id ORDER BY cp.position) AS n,
	       count(*)     OVER (PARTITION BY cp.contract_id)                      AS total
	  FROM contract_parties cp
	 WHERE cp.role = 'landlord'
), mismatched AS (
	SELECT c.id
	  FROM contracts c
	 WHERE (SELECT array_agg(person_id ORDER BY person_id) FROM contract_parties
	         WHERE contract_id = c.id AND role = 'landlord')
	    IS DISTINCT FROM
	       (SELECT array_agg(person_id ORDER BY person_id) FROM property_owners
	         WHERE property_id = c.property_id)
)
UPDATE contract_parties cp
   SET share = CASE WHEN l.n = l.total THEN 1000000 - (1000000 / l.total) * (l.total - 1)
                    ELSE 1000000 / l.total END
  FROM landlords l
 WHERE cp.contract_id = l.contract_id AND cp.person_id = l.person_id AND cp.role = 'landlord'
   AND cp.contract_id IN (SELECT id FROM mismatched);

-- Shares, when a contract has them, are on every landlord and add up to 100%.
-- Checked at commit, since replacing the parties deletes and inserts row by row.
CREATE FUNCTION check_landlord_shares() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target  uuid;
	with_share integer;
	without integer;
	total   bigint;
BEGIN
	IF TG_OP = 'DELETE' THEN
		target := OLD.contract_id;
	ELSE
		target := NEW.contract_id;
	END IF;

	SELECT count(*) FILTER (WHERE share IS NOT NULL),
	       count(*) FILTER (WHERE share IS NULL),
	       COALESCE(sum(share), 0)
	  INTO with_share, without, total
	  FROM contract_parties WHERE contract_id = target AND role = 'landlord';

	IF with_share > 0 AND (without > 0 OR total <> 1000000) THEN
		RAISE EXCEPTION 'landlords of contract % hold % millionths over % of % landlords',
			target, total, with_share, with_share + without
			USING ERRCODE = 'check_violation', CONSTRAINT = 'contract_parties_shares_total';
	END IF;
	RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER contract_parties_shares_total
	AFTER INSERT OR UPDATE OR DELETE ON contract_parties
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION check_landlord_shares();

-- A payout: lines of one beneficiary closed on the day the office transferred.
-- Numbered per office and year for the receipt, 2026/0001.
CREATE TABLE payouts (
	id              uuid        PRIMARY KEY,
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	person_id       uuid        NOT NULL,
	year            integer     NOT NULL CHECK (year BETWEEN 2000 AND 9999),
	sequence        integer     NOT NULL CHECK (sequence > 0),
	paid_on         date        NOT NULL,
	total           bigint      NOT NULL CHECK (total > 0),
	method          text        NOT NULL DEFAULT '' CHECK (method IN ('', 'pix', 'transfer', 'cash', 'check', 'other')),
	note            text        NOT NULL DEFAULT '' CHECK (length(note) <= 280),
	created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
	created_at      timestamptz NOT NULL,
	UNIQUE (organization_id, id),
	UNIQUE (organization_id, year, sequence),
	FOREIGN KEY (organization_id, person_id)
		REFERENCES people (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX payouts_person_idx ON payouts (organization_id, person_id, paid_on DESC, id DESC);
CREATE INDEX payouts_paid_idx   ON payouts (organization_id, paid_on DESC, id DESC);

-- The composite key the ledger's charge reference needs.
ALTER TABLE rent_charges ADD CONSTRAINT rent_charges_rent_id_id_key UNIQUE (rent_id, id);

-- The ledger. Every line is an amount with its sign: what the office owes the
-- person (a rent, a late fee, a charge, a credit) is positive; what it keeps
-- or deducts (its fee, the tax withheld, a debit) is negative. A line without
-- a payout is pending, and the pending sum is the balance to pay out.
CREATE TABLE owner_entries (
	id              uuid        PRIMARY KEY,
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	person_id       uuid        NOT NULL,
	kind            text        NOT NULL CHECK (kind IN ('rent', 'late_fee', 'charge', 'admin_fee', 'income_tax', 'debit', 'credit')),
	amount          bigint      NOT NULL CHECK (amount <> 0),
	occurred_on     date        NOT NULL,
	description     text        NOT NULL DEFAULT '' CHECK (length(description) <= 120),
	property_id     uuid,
	contract_id     uuid,
	rent_id         uuid,
	charge_id       uuid,
	payout_id       uuid,
	created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
	created_at      timestamptz NOT NULL,
	-- Credits are positive, deductions negative; the kind and the sign agree.
	CHECK ((kind IN ('rent', 'late_fee', 'charge', 'credit')) = (amount > 0)),
	-- A line from a rent names it; a manual line names no rent.
	CHECK ((kind IN ('debit', 'credit')) = (rent_id IS NULL)),
	CHECK ((kind = 'charge') = (charge_id IS NOT NULL)),
	FOREIGN KEY (organization_id, person_id)
		REFERENCES people (organization_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (organization_id, property_id)
		REFERENCES properties (organization_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (organization_id, contract_id)
		REFERENCES contracts (organization_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (organization_id, rent_id)
		REFERENCES rents (organization_id, id) ON DELETE RESTRICT,
	FOREIGN KEY (rent_id, charge_id)
		REFERENCES rent_charges (rent_id, id) ON DELETE RESTRICT,
	-- Undoing a payout deletes it, which returns its lines to the balance.
	FOREIGN KEY (organization_id, payout_id)
		REFERENCES payouts (organization_id, id) ON DELETE SET NULL (payout_id)
);

CREATE INDEX owner_entries_pending_idx ON owner_entries (organization_id, person_id, occurred_on, id)
	WHERE payout_id IS NULL;
CREATE INDEX owner_entries_payout_idx  ON owner_entries (payout_id) WHERE payout_id IS NOT NULL;
CREATE INDEX owner_entries_rent_idx    ON owner_entries (rent_id) WHERE rent_id IS NOT NULL;
CREATE INDEX owner_entries_person_idx  ON owner_entries (organization_id, person_id, occurred_on DESC, id DESC);

-- A line is never edited: only its payout comes and goes. And a line inside a
-- payout cannot be deleted; the payout has to be undone first.
REVOKE UPDATE ON owner_entries FROM imobiliary_app;
GRANT UPDATE (payout_id) ON owner_entries TO imobiliary_app;

CREATE FUNCTION refuse_paid_out_entry_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD.payout_id IS NOT NULL THEN
		RAISE EXCEPTION 'entry % is in payout %', OLD.id, OLD.payout_id
			USING ERRCODE = 'restrict_violation', CONSTRAINT = 'owner_entries_paid_out';
	END IF;
	RETURN OLD;
END;
$$;

CREATE TRIGGER owner_entries_paid_out
	BEFORE DELETE ON owner_entries
	FOR EACH ROW EXECUTE FUNCTION refuse_paid_out_entry_delete();

ALTER TABLE payouts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts       FORCE ROW LEVEL SECURITY;
ALTER TABLE owner_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON payouts
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON owner_entries
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
