-- Whether the first rent is paid in advance, on the day the lease starts, or
-- at the end of the first month. The office chooses per contract. Contracts
-- registered before the choice existed were all in advance.
ALTER TABLE contracts ADD COLUMN advance_rent boolean NOT NULL DEFAULT true;
ALTER TABLE contracts ALTER COLUMN advance_rent DROP DEFAULT;
