-- Foundation: extensions, the search helper, and the privileges of the
-- application role.
--
-- Migrations run as the role that owns the schema. The service connects as
-- imobiliary_app, a separate role created by scripts/setup-local.sql (and by
-- the deployment's own provisioning): it may read and write rows, but it owns
-- nothing and cannot change the schema.

-- All three are trusted extensions, which the database owner may create
-- without superuser rights.
--   btree_gist: lets an exclusion constraint combine a uuid equality with a
--               date-range overlap (one active contract per property).
--   pg_trgm:    trigram indexes for searching names by fragment.
--   unaccent:   so "joao" finds "João".
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is only STABLE, because its dictionary could change, so it cannot
-- appear in an index expression. Naming the dictionary explicitly makes the
-- result fixed, which is what IMMUTABLE promises.
CREATE FUNCTION immutable_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

GRANT USAGE ON SCHEMA public TO imobiliary_app;

-- The service checks the schema version at start-up and must not be able to
-- forge it.
GRANT SELECT ON schema_migrations TO imobiliary_app;

-- Every table, sequence and function this role creates from here on is usable
-- by the application. Tables that must be append-only, such as the audit
-- trail, revoke UPDATE and DELETE in the migration that creates them.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO imobiliary_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT USAGE, SELECT ON SEQUENCES TO imobiliary_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
	GRANT EXECUTE ON FUNCTIONS TO imobiliary_app;
