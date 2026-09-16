-- People and their addresses: the first business data, and the first tables
-- under row-level security.
--
-- Every table here carries organization_id and a policy that shows a row only
-- inside a transaction scoped to that organisation (DB.InOrganization). A
-- query that forgets its WHERE clause still sees one office's rows, and a
-- query run outside a scope sees none.
--
-- The link from each row to its office is RESTRICT, never CASCADE. Deleting an
-- office that still holds people fails in the database itself, which is the
-- rule the user chose for closing an account: nothing an office registered
-- disappears as a side effect.

-- The organisation of the current transaction, or null outside a scope. The
-- NULLIF matters: current_setting answers an empty string when the setting was
-- never made, and ''::uuid is an error rather than a non-match.
CREATE FUNCTION app_organization_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid $$;

CREATE TABLE people (
	id              uuid        PRIMARY KEY,
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	kind            text        NOT NULL CHECK (kind IN ('individual', 'company')),
	-- Full name of an individual, legal name of a company. In the clear,
	-- because it has to be searchable; access control protects it.
	name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
	-- Sealed with the field key against this row.
	email           bytea,
	phone           bytea,
	version         integer     NOT NULL DEFAULT 1,
	created_at      timestamptz NOT NULL,
	updated_at      timestamptz NOT NULL,
	-- The target of every composite foreign key below, so a link can only ever
	-- join rows of the same office.
	UNIQUE (organization_id, id)
);

-- "joao" finds "João", and a fragment finds a surname: trigram search over the
-- folded name.
CREATE INDEX people_name_search_idx ON people
	USING gin (immutable_unaccent(lower(name)) gin_trgm_ops);
-- The list is alphabetical and paged by (folded name, id).
CREATE INDEX people_name_order_idx ON people
	(organization_id, immutable_unaccent(lower(name)), id);

CREATE TABLE individuals (
	person_id       uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	-- Sealed. The index is an HMAC scoped to the office, so an exact lookup
	-- works and two offices holding the same CPF cannot be told apart.
	cpf             bytea,
	cpf_index       bytea,
	nationality     text NOT NULL DEFAULT '',
	marital_status  text CHECK (marital_status IN
		('single', 'married', 'stable_union', 'divorced', 'separated', 'widowed')),
	property_regime text CHECK (property_regime IN
		('partial_community', 'universal_community', 'total_separation',
		 'mandatory_separation', 'final_participation')),
	spouse_id       uuid,
	occupation      text NOT NULL DEFAULT '',
	birth_date      bytea,
	gender          text CHECK (gender IN ('female', 'male')),
	FOREIGN KEY (organization_id, person_id)
		REFERENCES people (organization_id, id) ON DELETE CASCADE,
	-- Deleting a spouse clears the link on the other side, and only the link:
	-- the column list keeps organization_id from being nulled with it.
	FOREIGN KEY (organization_id, spouse_id)
		REFERENCES people (organization_id, id) ON DELETE SET NULL (spouse_id),
	CHECK (spouse_id IS NULL OR spouse_id <> person_id),
	CHECK ((cpf IS NULL) = (cpf_index IS NULL)),
	UNIQUE (organization_id, cpf_index)
);

CREATE INDEX individuals_spouse_idx ON individuals (spouse_id);

CREATE TABLE companies (
	person_id       uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	trade_name      text NOT NULL DEFAULT '',
	cnpj            bytea,
	cnpj_index      bytea,
	FOREIGN KEY (organization_id, person_id)
		REFERENCES people (organization_id, id) ON DELETE CASCADE,
	CHECK ((cnpj IS NULL) = (cnpj_index IS NULL)),
	UNIQUE (organization_id, cnpj_index)
);

-- Who represents a company: a link, not a role on the person. Deleting the
-- company removes its links; deleting a person who still represents one is
-- refused, as every link is.
CREATE TABLE company_representatives (
	organization_id uuid NOT NULL,
	company_id      uuid NOT NULL,
	person_id       uuid NOT NULL,
	position        integer NOT NULL,
	PRIMARY KEY (company_id, person_id),
	FOREIGN KEY (organization_id, company_id)
		REFERENCES people (organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, person_id)
		REFERENCES people (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX company_representatives_person_idx ON company_representatives (person_id);

-- An address row has exactly one owner. A person's addresses are listed in
-- person_addresses; a property's single address arrives in phase 3.
CREATE TABLE addresses (
	id              uuid        PRIMARY KEY,
	organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	street          text        NOT NULL CHECK (length(street) BETWEEN 1 AND 120),
	number          text        NOT NULL DEFAULT '',
	complement      text        NOT NULL DEFAULT '',
	district        text        NOT NULL DEFAULT '',
	city            text        NOT NULL CHECK (length(city) BETWEEN 1 AND 120),
	state           char(2)     NOT NULL CHECK (state IN (
		'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA',
		'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO')),
	zip_code        char(8)     NOT NULL CHECK (zip_code ~ '^[0-9]{8}$'),
	observation     text        NOT NULL DEFAULT '',
	created_at      timestamptz NOT NULL,
	updated_at      timestamptz NOT NULL,
	UNIQUE (organization_id, id)
);

CREATE TABLE person_addresses (
	organization_id uuid    NOT NULL,
	person_id       uuid    NOT NULL,
	-- UNIQUE: an address belongs to one person, never shared.
	address_id      uuid    NOT NULL UNIQUE,
	kind            text    NOT NULL CHECK (kind IN ('residential', 'correspondence', 'commercial')),
	is_primary      boolean NOT NULL DEFAULT false,
	position        integer NOT NULL,
	PRIMARY KEY (person_id, address_id),
	FOREIGN KEY (organization_id, person_id)
		REFERENCES people (organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, address_id)
		REFERENCES addresses (organization_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX person_addresses_one_primary
	ON person_addresses (person_id) WHERE is_primary;

-- Row-level security, forced: the policies apply to the tables' owner as well,
-- not only to the application role. The owner only migrates and never reads
-- these rows, and the integration suite, which runs as the owner of its own
-- databases, then exercises the same isolation production relies on. The
-- repositories filter by nothing else, so a missing policy fails a test.
ALTER TABLE people                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE individuals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies               ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_representatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses               ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_addresses        ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON people
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON individuals
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON companies
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON company_representatives
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON addresses
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON person_addresses
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());

ALTER TABLE people                  FORCE ROW LEVEL SECURITY;
ALTER TABLE individuals             FORCE ROW LEVEL SECURITY;
ALTER TABLE companies               FORCE ROW LEVEL SECURITY;
ALTER TABLE company_representatives FORCE ROW LEVEL SECURITY;
ALTER TABLE addresses               FORCE ROW LEVEL SECURITY;
ALTER TABLE person_addresses        FORCE ROW LEVEL SECURITY;
