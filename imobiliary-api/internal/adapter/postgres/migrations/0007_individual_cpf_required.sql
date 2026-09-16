-- Every individual carries a CPF.
--
-- The user decided (2026-09-16) that the CPF is not optional: it is what
-- identifies an individual, and the national identity card uses the same
-- number. The domain refuses an individual without one; the columns now say
-- the same, so no path around the domain can store one.
--
-- This fails, on purpose, if an individual without a CPF was stored before:
-- completing that record is a decision for the office, not for a migration.
ALTER TABLE individuals ALTER COLUMN cpf SET NOT NULL;
ALTER TABLE individuals ALTER COLUMN cpf_index SET NOT NULL;
