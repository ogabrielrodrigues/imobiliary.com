-- Local PostgreSQL setup for imobiliary-api. Run once, as the superuser:
--
--   psql -U postgres -f imobiliary-api/scripts/setup-local.sql
--
-- It creates three roles and one database, then asks for each password
-- interactively, so no password is ever written in this file or in a shell
-- history.
--
--   imobiliary_owner  owns the schema; the migrate command connects as it.
--   imobiliary_app    reads and writes rows; the service connects as it. It
--                     owns nothing and cannot change the schema.
--   imobiliary_test   creates a throwaway database per integration test.
--
-- Production provisions the same two first roles with its own tooling; the
-- migrations grant to imobiliary_app by name.

\set ON_ERROR_STOP on

CREATE ROLE imobiliary_owner LOGIN;
CREATE ROLE imobiliary_app LOGIN;
CREATE ROLE imobiliary_test LOGIN CREATEDB;

CREATE DATABASE imobiliary OWNER imobiliary_owner ENCODING 'UTF8' TEMPLATE template0;

-- PUBLIC may connect to a new database by default. Only the two roles should.
REVOKE CONNECT ON DATABASE imobiliary FROM PUBLIC;
GRANT CONNECT ON DATABASE imobiliary TO imobiliary_owner, imobiliary_app;

\echo
\echo 'Password for imobiliary_owner (used by the migrate command):'
\password imobiliary_owner
\echo 'Password for imobiliary_app (used by the service):'
\password imobiliary_app
\echo 'Password for imobiliary_test (used by the integration tests):'
\password imobiliary_test
\echo
\echo 'Done. Put the passwords in %APPDATA%\postgresql\pgpass.conf, not in .env.'
