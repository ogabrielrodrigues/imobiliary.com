package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"uuid"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// InOrganization runs fn with the business repositories bound to a transaction
// scoped to one office, which is what makes row-level security apply.
func (db *DB) InOrganization(ctx context.Context, organizationID uuid.UUID, fn func(usecase.ScopedRepositories) error) error {
	return db.InOrganizationTx(ctx, organizationID, func(tx pgx.Tx) error {
		return fn(usecase.ScopedRepositories{
			People:     &personRepository{q: tx, organizationID: organizationID},
			Properties: &propertyRepository{q: tx, organizationID: organizationID},
			Contracts:  &contractRepository{q: tx, organizationID: organizationID},
			Amendments: &amendmentRepository{q: tx, organizationID: organizationID},
			Rents:      &rentRepository{q: tx, organizationID: organizationID},
			Dashboard:  &dashboardRepository{q: tx},
			Audit:      &auditRepository{tx},
		})
	})
}

var _ usecase.OrganizationScope = (*DB)(nil)

type personRepository struct {
	q              querier
	organizationID uuid.UUID
}

// isForeignKeyViolation reports a row still referenced, or a reference to a row
// that does not exist: 23503, or 23001 for a RESTRICT action, which PostgreSQL
// reports under its own code.
func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "23503" || pgErr.Code == "23001")
}

func constraintOf(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.ConstraintName
	}
	return ""
}

// duplicateDocument turns the unique index on a blind index into the field
// error a form can show.
func duplicateDocument(err error) error {
	if !isUniqueViolation(err) {
		return err
	}
	v := &domain.ValidationError{}
	switch constraint := constraintOf(err); {
	case strings.Contains(constraint, "cpf"):
		v.Add("cpf", "is already registered in this office")
	case strings.Contains(constraint, "cnpj"):
		v.Add("cnpj", "is already registered in this office")
	default:
		return fmt.Errorf("%w: %w", domain.ErrAlreadyExists, err)
	}
	return v
}

func nullBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

func nullText(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (r *personRepository) Create(ctx context.Context, sp *usecase.StoredPerson) error {
	p := &sp.Person
	_, err := r.q.Exec(ctx,
		`INSERT INTO people (id, organization_id, kind, name, email, phone, version, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7)`,
		pgUUID(p.ID), pgUUID(r.organizationID), string(p.Kind), p.Name,
		nullBytes(sp.Email), nullBytes(sp.Phone), p.CreatedAt)
	if err != nil {
		return fmt.Errorf("postgres: create person: %w", err)
	}
	if err := r.writeDetails(ctx, sp, true); err != nil {
		return err
	}
	return r.writeAddresses(ctx, p, p.CreatedAt)
}

func (r *personRepository) Update(ctx context.Context, sp *usecase.StoredPerson, version int) error {
	p := &sp.Person
	tag, err := r.q.Exec(ctx,
		`UPDATE people SET name = $2, email = $3, phone = $4, version = version + 1, updated_at = $5
		  WHERE id = $1 AND version = $6`,
		pgUUID(p.ID), p.Name, nullBytes(sp.Email), nullBytes(sp.Phone), p.UpdatedAt, version)
	if err != nil {
		return fmt.Errorf("postgres: update person: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Either gone or changed since it was read; tell the two apart, since
		// the answers differ (404 against 412).
		var exists bool
		if err := r.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM people WHERE id = $1)`, pgUUID(p.ID)).Scan(&exists); err != nil {
			return fmt.Errorf("postgres: update person: %w", err)
		}
		if !exists {
			return fmt.Errorf("postgres: update person: %w", domain.ErrNotFound)
		}
		return fmt.Errorf("postgres: update person: %w", domain.ErrPreconditionFailed)
	}
	if err := r.writeDetails(ctx, sp, false); err != nil {
		return err
	}
	if _, err := r.q.Exec(ctx,
		`DELETE FROM addresses WHERE id IN (SELECT address_id FROM person_addresses WHERE person_id = $1)`,
		pgUUID(p.ID)); err != nil {
		return fmt.Errorf("postgres: replace addresses: %w", err)
	}
	return r.writeAddresses(ctx, p, p.UpdatedAt)
}

// writeDetails writes the row of the person's kind and, for a company, its
// representatives.
func (r *personRepository) writeDetails(ctx context.Context, sp *usecase.StoredPerson, created bool) error {
	p := &sp.Person
	id, org := pgUUID(p.ID), pgUUID(r.organizationID)

	if p.Kind == domain.PersonIndividual {
		var birth any
		if len(sp.BirthDate) > 0 {
			birth = sp.BirthDate
		}
		_, err := r.q.Exec(ctx,
			`INSERT INTO individuals (person_id, organization_id, cpf, cpf_index, nationality,
				marital_status, property_regime, spouse_id, occupation, birth_date, gender)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			 ON CONFLICT (person_id) DO UPDATE SET
				cpf = excluded.cpf, cpf_index = excluded.cpf_index, nationality = excluded.nationality,
				marital_status = excluded.marital_status, property_regime = excluded.property_regime,
				spouse_id = excluded.spouse_id, occupation = excluded.occupation,
				birth_date = excluded.birth_date, gender = excluded.gender`,
			id, org, nullBytes(sp.CPF), nullBytes(sp.CPFIndex), p.Nationality,
			nullText(string(p.MaritalStatus)), nullText(string(p.PropertyRegime)), pgNullUUID(p.SpouseID),
			p.Occupation, birth, nullText(string(p.Gender)))
		if err != nil {
			return fmt.Errorf("postgres: write individual: %w", duplicateDocument(err))
		}
		return nil
	}

	_, err := r.q.Exec(ctx,
		`INSERT INTO companies (person_id, organization_id, trade_name, cnpj, cnpj_index)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (person_id) DO UPDATE SET
			trade_name = excluded.trade_name, cnpj = excluded.cnpj, cnpj_index = excluded.cnpj_index`,
		id, org, p.TradeName, nullBytes(sp.CNPJ), nullBytes(sp.CNPJIndex))
	if err != nil {
		return fmt.Errorf("postgres: write company: %w", duplicateDocument(err))
	}
	if !created {
		if _, err := r.q.Exec(ctx, `DELETE FROM company_representatives WHERE company_id = $1`, id); err != nil {
			return fmt.Errorf("postgres: replace representatives: %w", err)
		}
	}
	for i, representative := range p.RepresentativeIDs {
		if _, err := r.q.Exec(ctx,
			`INSERT INTO company_representatives (organization_id, company_id, person_id, position)
			 VALUES ($1, $2, $3, $4)`,
			org, id, pgUUID(representative), i); err != nil {
			if isForeignKeyViolation(err) {
				v := &domain.ValidationError{}
				v.Add("representative_ids", "names a person that does not exist")
				return v
			}
			return fmt.Errorf("postgres: write representative: %w", err)
		}
	}
	return nil
}

func (r *personRepository) writeAddresses(ctx context.Context, p *domain.Person, at time.Time) error {
	for i := range p.Addresses {
		a := &p.Addresses[i]
		a.ID = uuid.NewV7()
		if _, err := r.q.Exec(ctx,
			`INSERT INTO addresses (id, organization_id, street, number, complement, district, city,
				state, zip_code, observation, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
			pgUUID(a.ID), pgUUID(r.organizationID), a.Street, a.Number, a.Complement, a.District,
			a.City, a.State, a.ZipCode, a.Observation, at); err != nil {
			return fmt.Errorf("postgres: write address: %w", err)
		}
		if _, err := r.q.Exec(ctx,
			`INSERT INTO person_addresses (organization_id, person_id, address_id, kind, is_primary, position)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			pgUUID(r.organizationID), pgUUID(p.ID), pgUUID(a.ID), string(a.Kind), a.IsPrimary, i); err != nil {
			return fmt.Errorf("postgres: link address: %w", err)
		}
	}
	return nil
}

func (r *personRepository) Get(ctx context.Context, id uuid.UUID) (*usecase.StoredPerson, error) {
	var (
		sp                             usecase.StoredPerson
		pid                            pgtype.UUID
		spouse                         pgtype.UUID
		kind                           string
		nationality, occupation        pgtype.Text
		marital, regime, gender, trade pgtype.Text
	)
	err := r.q.QueryRow(ctx,
		`SELECT p.id, p.kind, p.name, p.email, p.phone, p.version, p.created_at, p.updated_at,
		        i.cpf, i.cpf_index, i.nationality, i.marital_status, i.property_regime, i.spouse_id,
		        i.occupation, i.birth_date, i.gender,
		        c.trade_name, c.cnpj, c.cnpj_index
		   FROM people p
		   LEFT JOIN individuals i ON i.person_id = p.id
		   LEFT JOIN companies c ON c.person_id = p.id
		  WHERE p.id = $1`, pgUUID(id),
	).Scan(&pid, &kind, &sp.Person.Name, &sp.Email, &sp.Phone, &sp.Person.Version,
		&sp.Person.CreatedAt, &sp.Person.UpdatedAt,
		&sp.CPF, &sp.CPFIndex, &nationality, &marital, &regime, &spouse,
		&occupation, &sp.BirthDate, &gender,
		&trade, &sp.CNPJ, &sp.CNPJIndex)
	if err != nil {
		return nil, noRows(err, "postgres: person")
	}
	p := &sp.Person
	p.ID, p.OrganizationID, p.Kind = toUUID(pid), r.organizationID, domain.PersonKind(kind)
	p.Nationality, p.Occupation, p.TradeName = nationality.String, occupation.String, trade.String
	p.MaritalStatus = domain.MaritalStatus(marital.String)
	p.PropertyRegime = domain.PropertyRegime(regime.String)
	p.Gender = domain.Gender(gender.String)
	p.SpouseID = toNullUUID(spouse)

	if p.Kind == domain.PersonCompany {
		rows, err := r.q.Query(ctx,
			`SELECT person_id FROM company_representatives WHERE company_id = $1 ORDER BY position`, pgUUID(id))
		if err != nil {
			return nil, fmt.Errorf("postgres: representatives: %w", err)
		}
		ids, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (uuid.UUID, error) {
			var v pgtype.UUID
			err := row.Scan(&v)
			return toUUID(v), err
		})
		if err != nil {
			return nil, fmt.Errorf("postgres: representatives: %w", err)
		}
		p.RepresentativeIDs = ids
	}

	rows, err := r.q.Query(ctx,
		`SELECT a.id, pa.kind, pa.is_primary, a.street, a.number, a.complement, a.district,
		        a.city, a.state, a.zip_code, a.observation
		   FROM person_addresses pa JOIN addresses a ON a.id = pa.address_id
		  WHERE pa.person_id = $1 ORDER BY pa.position`, pgUUID(id))
	if err != nil {
		return nil, fmt.Errorf("postgres: addresses: %w", err)
	}
	p.Addresses, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Address, error) {
		var (
			a    domain.Address
			aid  pgtype.UUID
			kind string
		)
		err := row.Scan(&aid, &kind, &a.IsPrimary, &a.Street, &a.Number, &a.Complement, &a.District,
			&a.City, &a.State, &a.ZipCode, &a.Observation)
		a.ID, a.Kind = toUUID(aid), domain.AddressKind(kind)
		return a, err
	})
	if err != nil {
		return nil, fmt.Errorf("postgres: addresses: %w", err)
	}
	return &sp, nil
}

func (r *personRepository) List(ctx context.Context, q usecase.PersonQuery) ([]domain.PersonSummary, []usecase.PersonCursor, error) {
	var (
		where []string
		args  []any
	)
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	switch {
	case len(q.CPFIndex) > 0:
		where = append(where, "i.cpf_index = "+arg(q.CPFIndex))
	case len(q.CNPJIndex) > 0:
		where = append(where, "c.cnpj_index = "+arg(q.CNPJIndex))
	case q.NameContains != "":
		// The pattern's own wildcards are escaped, so "50%" is a name
		// fragment and not an instruction.
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q.NameContains)
		where = append(where, "immutable_unaccent(lower(p.name)) LIKE '%' || immutable_unaccent(lower("+arg(escaped)+")) || '%'")
	}
	if q.Kind != "" {
		where = append(where, "p.kind = "+arg(string(q.Kind)))
	}
	if q.After != nil {
		where = append(where, "(immutable_unaccent(lower(p.name)), p.id) > ("+arg(q.After.SortKey)+", "+arg(pgUUID(q.After.ID))+")")
	}
	sql := `SELECT p.id, p.kind, p.name, COALESCE(c.trade_name, ''), p.created_at, immutable_unaccent(lower(p.name))
	          FROM people p
	          LEFT JOIN individuals i ON i.person_id = p.id
	          LEFT JOIN companies c ON c.person_id = p.id`
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY immutable_unaccent(lower(p.name)), p.id LIMIT " + arg(q.Limit)

	rows, err := r.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("postgres: list people: %w", err)
	}
	defer rows.Close()

	var (
		people  []domain.PersonSummary
		cursors []usecase.PersonCursor
	)
	for rows.Next() {
		var (
			s    domain.PersonSummary
			id   pgtype.UUID
			kind string
			key  string
		)
		if err := rows.Scan(&id, &kind, &s.Name, &s.TradeName, &s.CreatedAt, &key); err != nil {
			return nil, nil, fmt.Errorf("postgres: list people: %w", err)
		}
		s.ID, s.Kind = toUUID(id), domain.PersonKind(kind)
		people = append(people, s)
		cursors = append(cursors, usecase.PersonCursor{SortKey: key, ID: s.ID})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("postgres: list people: %w", err)
	}
	return people, cursors, nil
}

func (r *personRepository) Links(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]usecase.PersonLink, error) {
	out := make(map[uuid.UUID]usecase.PersonLink, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	params := make([]pgtype.UUID, len(ids))
	for i, id := range ids {
		params[i] = pgUUID(id)
	}
	rows, err := r.q.Query(ctx,
		`SELECT p.id, p.kind, p.name, i.marital_status, i.property_regime, i.spouse_id
		   FROM people p LEFT JOIN individuals i ON i.person_id = p.id
		  WHERE p.id = ANY($1)`, params)
	if err != nil {
		return nil, fmt.Errorf("postgres: person links: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			l       usecase.PersonLink
			id, sp  pgtype.UUID
			kind    string
			marital pgtype.Text
			regime  pgtype.Text
		)
		if err := rows.Scan(&id, &kind, &l.Name, &marital, &regime, &sp); err != nil {
			return nil, fmt.Errorf("postgres: person links: %w", err)
		}
		l.ID, l.Kind = toUUID(id), domain.PersonKind(kind)
		l.MaritalStatus, l.SpouseID = domain.MaritalStatus(marital.String), toNullUUID(sp)
		l.PropertyRegime = domain.PropertyRegime(regime.String)
		out[l.ID] = l
	}
	return out, rows.Err()
}

func (r *personRepository) SetSpouse(ctx context.Context, personID uuid.UUID, spouseID *uuid.UUID, at time.Time) error {
	if _, err := r.q.Exec(ctx,
		`UPDATE individuals SET spouse_id = $2 WHERE person_id = $1`,
		pgUUID(personID), pgNullUUID(spouseID)); err != nil {
		return fmt.Errorf("postgres: set spouse: %w", err)
	}
	tag, err := r.q.Exec(ctx,
		`UPDATE people SET version = version + 1, updated_at = $2 WHERE id = $1`, pgUUID(personID), at)
	return affected(tag, err, "postgres: set spouse")
}

func (r *personRepository) Delete(ctx context.Context, id uuid.UUID) error {
	// The addresses are the person's own rows; removing them first leaves
	// nothing behind once the person goes.
	if _, err := r.q.Exec(ctx,
		`DELETE FROM addresses WHERE id IN (SELECT address_id FROM person_addresses WHERE person_id = $1)`,
		pgUUID(id)); err != nil {
		return fmt.Errorf("postgres: delete addresses: %w", err)
	}
	tag, err := r.q.Exec(ctx, `DELETE FROM people WHERE id = $1`, pgUUID(id))
	if isForeignKeyViolation(err) {
		return fmt.Errorf("postgres: delete person: %w", domain.ErrInUse)
	}
	return affected(tag, err, "postgres: delete person")
}
