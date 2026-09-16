-- Properties and their owners.
--
-- Same rules as people (0005): every row carries organization_id, row-level
-- security is forced, and the link to the office is RESTRICT. A property's
-- address is a row of addresses owned by the property alone.

CREATE TABLE properties (
	id                     uuid        PRIMARY KEY,
	organization_id        uuid        NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
	-- UNIQUE: one address row per property, never shared with a person or
	-- another property. RESTRICT: the address goes after the property does.
	address_id             uuid        NOT NULL UNIQUE,
	registry               text        NOT NULL DEFAULT '',
	registry_office        text        NOT NULL DEFAULT '',
	municipal_registration text        NOT NULL DEFAULT '',
	water_code             text        NOT NULL DEFAULT '',
	energy_code            text        NOT NULL DEFAULT '',
	version                integer     NOT NULL DEFAULT 1,
	created_at             timestamptz NOT NULL,
	updated_at             timestamptz NOT NULL,
	UNIQUE (organization_id, id),
	FOREIGN KEY (organization_id, address_id)
		REFERENCES addresses (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE property_owners (
	organization_id uuid    NOT NULL,
	property_id     uuid    NOT NULL,
	person_id       uuid    NOT NULL,
	-- A rate in millionths: 1000000 is 100%.
	share           integer NOT NULL CHECK (share > 0 AND share <= 1000000),
	position        integer NOT NULL,
	PRIMARY KEY (property_id, person_id),
	FOREIGN KEY (organization_id, property_id)
		REFERENCES properties (organization_id, id) ON DELETE CASCADE,
	-- An owner cannot be deleted while they own something.
	FOREIGN KEY (organization_id, person_id)
		REFERENCES people (organization_id, id) ON DELETE RESTRICT
);

CREATE INDEX property_owners_person_idx ON property_owners (person_id);

-- Search by address: "flores" finds "Rua das Flores", "bebedouro" the city.
CREATE INDEX addresses_search_idx ON addresses
	USING gin (immutable_unaccent(lower(street || ' ' || district || ' ' || city)) gin_trgm_ops);

-- The owners of a property add up to exactly 100%, checked at commit.
--
-- Deferred, because replacing the owners of a property deletes and inserts
-- rows one statement at a time, and the sum is only meaningful once all of
-- them are in. The domain checks the same rule first, so this fires only on a
-- bug; it is what makes the rule true of the data rather than of the code.
CREATE FUNCTION check_property_shares() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	target uuid;
	total  bigint;
BEGIN
	IF TG_TABLE_NAME = 'properties' THEN
		target := NEW.id;
	ELSIF TG_OP = 'DELETE' THEN
		target := OLD.property_id;
	ELSE
		target := NEW.property_id;
	END IF;

	-- A property deleted in the same transaction has no owners to check.
	IF NOT EXISTS (SELECT 1 FROM properties WHERE id = target) THEN
		RETURN NULL;
	END IF;

	SELECT COALESCE(sum(share), 0) INTO total FROM property_owners WHERE property_id = target;
	IF total <> 1000000 THEN
		RAISE EXCEPTION 'owners of property % hold % millionths, not 1000000', target, total
			USING ERRCODE = 'check_violation', CONSTRAINT = 'property_owners_shares_total';
	END IF;
	RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER property_owners_shares_total
	AFTER INSERT OR UPDATE OR DELETE ON property_owners
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION check_property_shares();

-- A property inserted with no owner at all is caught too.
CREATE CONSTRAINT TRIGGER properties_have_owners
	AFTER INSERT ON properties
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION check_property_shares();

ALTER TABLE properties      ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties      FORCE ROW LEVEL SECURITY;
ALTER TABLE property_owners FORCE ROW LEVEL SECURITY;

CREATE POLICY organization_scope ON properties
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
CREATE POLICY organization_scope ON property_owners
	USING (organization_id = app_organization_id()) WITH CHECK (organization_id = app_organization_id());
