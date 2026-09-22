-- The administrator's document is sealed like a person's, so it is bytes, not
-- text: 0012 declared it text by mistake. Nothing had been written to it.
ALTER TABLE organizations
	ALTER COLUMN administrator_document TYPE bytea USING NULL;
