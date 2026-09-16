package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"uuid"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

type propertyRepository struct {
	q              querier
	organizationID uuid.UUID
}

// propertySortKey is how the list orders properties: by folded street and
// number, the way someone looks one up.
const propertySortKey = `immutable_unaccent(lower(a.street || ' ' || a.number))`

func (r *propertyRepository) Create(ctx context.Context, p *domain.Property) error {
	p.Address.ID = uuid.NewV7()
	if err := r.insertAddress(ctx, &p.Address, p.CreatedAt); err != nil {
		return err
	}
	_, err := r.q.Exec(ctx,
		`INSERT INTO properties (id, organization_id, address_id, registry, registry_office,
			municipal_registration, water_code, energy_code, version, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9)`,
		pgUUID(p.ID), pgUUID(r.organizationID), pgUUID(p.Address.ID), p.Registry, p.RegistryOffice,
		p.MunicipalRegistration, p.WaterCode, p.EnergyCode, p.CreatedAt)
	if err != nil {
		return fmt.Errorf("postgres: create property: %w", err)
	}
	return r.insertOwners(ctx, p)
}

func (r *propertyRepository) Update(ctx context.Context, p *domain.Property, version int) error {
	var addressID pgtype.UUID
	err := r.q.QueryRow(ctx,
		`UPDATE properties SET registry = $2, registry_office = $3, municipal_registration = $4,
			water_code = $5, energy_code = $6, version = version + 1, updated_at = $7
		  WHERE id = $1 AND version = $8
		  RETURNING address_id`,
		pgUUID(p.ID), p.Registry, p.RegistryOffice, p.MunicipalRegistration,
		p.WaterCode, p.EnergyCode, p.UpdatedAt, version,
	).Scan(&addressID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("postgres: update property: %w", err)
		}
		var exists bool
		if err := r.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM properties WHERE id = $1)`, pgUUID(p.ID)).Scan(&exists); err != nil {
			return fmt.Errorf("postgres: update property: %w", err)
		}
		if !exists {
			return fmt.Errorf("postgres: update property: %w", domain.ErrNotFound)
		}
		return fmt.Errorf("postgres: update property: %w", domain.ErrPreconditionFailed)
	}

	// The address row stays the same row: its identifier is what a contract
	// may point at later.
	p.Address.ID = toUUID(addressID)
	a := p.Address
	if _, err := r.q.Exec(ctx,
		`UPDATE addresses SET street = $2, number = $3, complement = $4, district = $5, city = $6,
			state = $7, zip_code = $8, observation = $9, updated_at = $10
		  WHERE id = $1`,
		pgUUID(a.ID), a.Street, a.Number, a.Complement, a.District, a.City, a.State, a.ZipCode,
		a.Observation, p.UpdatedAt); err != nil {
		return fmt.Errorf("postgres: update property address: %w", err)
	}
	if _, err := r.q.Exec(ctx, `DELETE FROM property_owners WHERE property_id = $1`, pgUUID(p.ID)); err != nil {
		return fmt.Errorf("postgres: replace owners: %w", err)
	}
	return r.insertOwners(ctx, p)
}

func (r *propertyRepository) insertAddress(ctx context.Context, a *domain.Address, at time.Time) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO addresses (id, organization_id, street, number, complement, district, city,
			state, zip_code, observation, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
		pgUUID(a.ID), pgUUID(r.organizationID), a.Street, a.Number, a.Complement, a.District,
		a.City, a.State, a.ZipCode, a.Observation, at)
	if err != nil {
		return fmt.Errorf("postgres: write property address: %w", err)
	}
	return nil
}

func (r *propertyRepository) insertOwners(ctx context.Context, p *domain.Property) error {
	for i, owner := range p.Owners {
		_, err := r.q.Exec(ctx,
			`INSERT INTO property_owners (organization_id, property_id, person_id, share, position)
			 VALUES ($1, $2, $3, $4, $5)`,
			pgUUID(r.organizationID), pgUUID(p.ID), pgUUID(owner.PersonID), int32(owner.Share), i)
		if isForeignKeyViolation(err) {
			v := &domain.ValidationError{}
			v.Add(fmt.Sprintf("owners[%d].person_id", i), "names a person that does not exist")
			return v
		}
		if err != nil {
			return fmt.Errorf("postgres: write owner: %w", err)
		}
	}
	return nil
}

const propertyColumns = `p.id, p.registry, p.registry_office, p.municipal_registration, p.water_code,
	p.energy_code, p.version, p.created_at, p.updated_at,
	a.id, a.street, a.number, a.complement, a.district, a.city, a.state, a.zip_code, a.observation`

func scanProperty(row pgx.Row, organizationID uuid.UUID) (*domain.Property, error) {
	var (
		p       domain.Property
		id, aid pgtype.UUID
	)
	err := row.Scan(&id, &p.Registry, &p.RegistryOffice, &p.MunicipalRegistration, &p.WaterCode,
		&p.EnergyCode, &p.Version, &p.CreatedAt, &p.UpdatedAt,
		&aid, &p.Address.Street, &p.Address.Number, &p.Address.Complement, &p.Address.District,
		&p.Address.City, &p.Address.State, &p.Address.ZipCode, &p.Address.Observation)
	if err != nil {
		return nil, noRows(err, "postgres: property")
	}
	p.ID, p.Address.ID, p.OrganizationID = toUUID(id), toUUID(aid), organizationID
	return &p, nil
}

func (r *propertyRepository) Get(ctx context.Context, id uuid.UUID) (*domain.Property, []usecase.PropertyOwnerView, error) {
	p, err := scanProperty(r.q.QueryRow(ctx,
		`SELECT `+propertyColumns+`
		   FROM properties p JOIN addresses a ON a.id = p.address_id
		  WHERE p.id = $1`, pgUUID(id)), r.organizationID)
	if err != nil {
		return nil, nil, err
	}

	rows, err := r.q.Query(ctx,
		`SELECT o.person_id, o.share, pe.name, pe.kind
		   FROM property_owners o JOIN people pe ON pe.id = o.person_id
		  WHERE o.property_id = $1 ORDER BY o.position`, pgUUID(id))
	if err != nil {
		return nil, nil, fmt.Errorf("postgres: owners: %w", err)
	}
	owners, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (usecase.PropertyOwnerView, error) {
		var (
			o     usecase.PropertyOwnerView
			pid   pgtype.UUID
			share int32
			kind  string
		)
		err := row.Scan(&pid, &share, &o.Name, &kind)
		o.PersonID, o.Share, o.Kind = toUUID(pid), domain.Rate(share), domain.PersonKind(kind)
		return o, err
	})
	if err != nil {
		return nil, nil, fmt.Errorf("postgres: owners: %w", err)
	}
	for _, o := range owners {
		p.Owners = append(p.Owners, domain.PropertyOwner{PersonID: o.PersonID, Share: o.Share})
	}
	return p, owners, nil
}

func (r *propertyRepository) List(ctx context.Context, q usecase.PropertyQuery) ([]domain.PropertySummary, []usecase.PropertyCursor, error) {
	var (
		where []string
		args  []any
	)
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if q.AddressContains != "" {
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q.AddressContains)
		pattern := "'%' || immutable_unaccent(lower(" + arg(escaped) + ")) || '%'"
		where = append(where, "(immutable_unaccent(lower(a.street || ' ' || a.district || ' ' || a.city)) LIKE "+pattern+
			" OR lower(p.registry) LIKE "+pattern+" OR lower(p.municipal_registration) LIKE "+pattern+")")
	}
	if q.OwnerID != nil {
		where = append(where, "EXISTS (SELECT 1 FROM property_owners o WHERE o.property_id = p.id AND o.person_id = "+arg(pgUUID(*q.OwnerID))+")")
	}
	if q.After != nil {
		where = append(where, "("+propertySortKey+", p.id) > ("+arg(q.After.SortKey)+", "+arg(pgUUID(q.After.ID))+")")
	}
	sql := `SELECT p.id, p.registry, p.created_at,
	               a.street, a.number, a.complement, a.district, a.city, a.state, a.zip_code,
	               ` + propertySortKey + `,
	               ARRAY(SELECT pe.name FROM property_owners o JOIN people pe ON pe.id = o.person_id
	                      WHERE o.property_id = p.id ORDER BY o.position)
	          FROM properties p JOIN addresses a ON a.id = p.address_id`
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY " + propertySortKey + ", p.id LIMIT " + arg(q.Limit)

	rows, err := r.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("postgres: list properties: %w", err)
	}
	defer rows.Close()

	var (
		out     []domain.PropertySummary
		cursors []usecase.PropertyCursor
	)
	for rows.Next() {
		var (
			s   domain.PropertySummary
			id  pgtype.UUID
			key string
		)
		if err := rows.Scan(&id, &s.Registry, &s.CreatedAt,
			&s.Address.Street, &s.Address.Number, &s.Address.Complement, &s.Address.District,
			&s.Address.City, &s.Address.State, &s.Address.ZipCode, &key, &s.OwnerNames); err != nil {
			return nil, nil, fmt.Errorf("postgres: list properties: %w", err)
		}
		s.ID = toUUID(id)
		out = append(out, s)
		cursors = append(cursors, usecase.PropertyCursor{SortKey: key, ID: s.ID})
	}
	return out, cursors, rows.Err()
}

func (r *propertyRepository) Delete(ctx context.Context, id uuid.UUID) error {
	var addressID pgtype.UUID
	err := r.q.QueryRow(ctx, `DELETE FROM properties WHERE id = $1 RETURNING address_id`, pgUUID(id)).Scan(&addressID)
	if isForeignKeyViolation(err) {
		return fmt.Errorf("postgres: delete property: %w", domain.ErrInUse)
	}
	if err != nil {
		return noRows(err, "postgres: delete property")
	}
	if _, err := r.q.Exec(ctx, `DELETE FROM addresses WHERE id = $1`, addressID); err != nil {
		return fmt.Errorf("postgres: delete property address: %w", err)
	}
	return nil
}
