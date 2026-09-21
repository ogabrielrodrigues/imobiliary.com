-- Partial payments (PLANO-PENDENCIAS.md §2). A rent is paid by one payment
-- or several; each is a row here. The rent keeps a summary of its payments,
-- written in the same transaction: amount_paid, late_fee, income_tax_withheld
-- and principal_paid are the sums, and paid_on is the day the principal was
-- settled, null while anything is open.

CREATE TABLE rent_payments (
	id              uuid        PRIMARY KEY,
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	rent_id         uuid        NOT NULL,
	paid_on         date        NOT NULL,
	-- What came in.
	amount          bigint      NOT NULL CHECK (amount >= 0),
	-- Interest and penalty settled, and forgiven, with this payment.
	late_fee        bigint      NOT NULL CHECK (late_fee >= 0),
	waived          bigint      NOT NULL DEFAULT 0 CHECK (waived >= 0),
	-- The rent and its charges settled.
	principal       bigint      NOT NULL CHECK (principal >= 0),
	income_tax      bigint      NOT NULL DEFAULT 0 CHECK (income_tax >= 0),
	created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
	created_at      timestamptz NOT NULL,
	UNIQUE (organization_id, id),
	UNIQUE (rent_id, id),
	FOREIGN KEY (organization_id, rent_id)
		REFERENCES rents (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX rent_payments_rent_idx ON rent_payments (rent_id, paid_on, id);
CREATE INDEX rent_payments_paid_idx ON rent_payments (organization_id, paid_on);

-- A partially paid rent has received money and is not yet paid.
ALTER TABLE rents DROP CONSTRAINT rents_check;
ALTER TABLE rents
	ADD COLUMN principal_paid bigint NOT NULL DEFAULT 0 CHECK (principal_paid >= 0),
	ADD CONSTRAINT rents_paid_has_payment CHECK (paid_on IS NULL OR amount_paid IS NOT NULL);

-- The rows below are the whole database's, and forced row security binds the
-- owner too: lifted for this migration only, and forced again at its end.
ALTER TABLE rents         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE rent_charges  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE owner_entries NO FORCE ROW LEVEL SECURITY;

-- Every rent paid so far was paid at once: one payment with its values as
-- recorded. Amounts typed before payouts existed need not add up, so the
-- equation below is checked on new rows only.
INSERT INTO rent_payments (id, organization_id, rent_id, paid_on, amount, late_fee, principal, income_tax, created_at)
SELECT uuidv7(), r.organization_id, r.id, r.paid_on, r.amount_paid, r.late_fee,
       r.rent_amount + COALESCE((SELECT sum(rc.amount) FROM rent_charges rc WHERE rc.rent_id = r.id), 0),
       r.income_tax_withheld, now()
  FROM rents r
 WHERE r.paid_on IS NOT NULL;

UPDATE rents r
   SET principal_paid = p.principal
  FROM rent_payments p
 WHERE p.rent_id = r.id;

ALTER TABLE rent_payments
	ADD CONSTRAINT rent_payments_adds_up CHECK (amount = late_fee + principal - income_tax) NOT VALID;

-- Each ledger line of a rent comes from one of its payments.
ALTER TABLE owner_entries ADD COLUMN payment_id uuid;

UPDATE owner_entries e
   SET payment_id = p.id
  FROM rent_payments p
 WHERE p.rent_id = e.rent_id;

ALTER TABLE owner_entries
	ADD CONSTRAINT owner_entries_payment_fkey FOREIGN KEY (rent_id, payment_id)
		REFERENCES rent_payments (rent_id, id) ON DELETE RESTRICT,
	ADD CONSTRAINT owner_entries_payment_check CHECK ((rent_id IS NULL) = (payment_id IS NULL));

CREATE INDEX owner_entries_payment_idx ON owner_entries (payment_id) WHERE payment_id IS NOT NULL;

ALTER TABLE rents         FORCE ROW LEVEL SECURITY;
ALTER TABLE rent_charges  FORCE ROW LEVEL SECURITY;
ALTER TABLE owner_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE rent_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rent_payments FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON rent_payments
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());

-- A payment is never edited: reversing one deletes it.
REVOKE UPDATE ON rent_payments FROM imobiliary_app;
