-- Records that an account accepted the terms, and which version of them.
--
-- Without this the acceptance is a checkbox that leaves no trace: the service
-- would be unable to show, later, that a user was ever presented with the
-- terms it is relying on. The version matters as much as the instant, because
-- the text changes and consent to one version is not consent to the next.
--
-- Both columns are nullable, and deliberately so. Accounts created before this
-- migration existed did accept nothing, and writing a timestamp for them would
-- be inventing a record of something that never happened. They read as NULL,
-- which is the truth, and can be asked to accept on their next sign-in.

ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE users ADD COLUMN terms_version TEXT;
