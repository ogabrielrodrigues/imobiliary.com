-- Anonymisation at the end of the legal retention (PLANO-PENDENCIAS.md §4).
-- The office confirms each person; the record stays, so contracts, rents and
-- the ledger keep pointing at it, and everything that identifies the person
-- goes.

ALTER TABLE people ADD COLUMN anonymized_at timestamptz;

-- An individual carries a CPF (migration 0007) until anonymised, when the CPF
-- and its blind index go, so the same CPF can be registered again as someone
-- else. The flag lives on the row the rule is about, since a CHECK cannot read
-- another table.
ALTER TABLE individuals
	ADD COLUMN anonymized boolean NOT NULL DEFAULT false,
	ALTER COLUMN cpf DROP NOT NULL,
	ALTER COLUMN cpf_index DROP NOT NULL,
	ADD CONSTRAINT individuals_cpf_unless_anonymized CHECK (anonymized OR cpf IS NOT NULL);
