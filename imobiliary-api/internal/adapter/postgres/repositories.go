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

// querier is what both the pool and a transaction offer, so every repository
// works the same inside a transaction and outside one.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Repositories returns the stores bound to the pool, for work that is a single
// statement and needs no transaction of its own.
func (db *DB) Repositories() usecase.Repositories {
	return repositoriesOn(db.pool)
}

// InTx runs fn against repositories bound to one transaction, committing when
// it returns nil and rolling back otherwise.
//
// This is not the organisation-scoped transaction: identity work happens
// before an organisation is known. InOrganization is the one that sets
// app.organization_id for the business data of phase 2 onwards.
func (db *DB) InTx(ctx context.Context, fn func(usecase.Repositories) error) error {
	tx, err := db.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin transaction: %w", err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	if err := fn(repositoriesOn(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("postgres: commit transaction: %w", err)
	}
	return nil
}

func repositoriesOn(q querier) usecase.Repositories {
	return usecase.Repositories{
		Organizations: &organizationRepository{q},
		Users:         &userRepository{q},
		Memberships:   &membershipRepository{q},
		Sessions:      &sessionRepository{q},
		Resets:        &passwordResetRepository{q},
		Invitations:   &invitationRepository{q},
		MFA:           &mfaRepository{q},
		Audit:         &auditRepository{q},
	}
}

// --- shared helpers ---------------------------------------------------------

// Identifiers cross the wire as pgtype.UUID rather than relying on pgx to
// recognise a named [16]byte. It is two short functions against a behaviour
// that would otherwise depend on the driver's reflection rules.
func pgUUID(id uuid.UUID) pgtype.UUID { return pgtype.UUID{Bytes: id, Valid: true} }

func pgNullUUID(id *uuid.UUID) pgtype.UUID {
	if id == nil {
		return pgtype.UUID{}
	}
	return pgUUID(*id)
}

func toUUID(v pgtype.UUID) uuid.UUID { return uuid.UUID(v.Bytes) }

func toNullUUID(v pgtype.UUID) *uuid.UUID {
	if !v.Valid {
		return nil
	}
	id := toUUID(v)
	return &id
}

// noRows turns pgx's sentinel into the domain's, so no layer above this one
// has to know which driver is underneath.
func noRows(err error, what string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%s: %w", what, domain.ErrNotFound)
	}
	return err
}

// isUniqueViolation reports a unique or exclusion constraint. pgx carries the
// SQLSTATE, so this is a code comparison rather than a search through an error
// message, which is what the SQLite adapter had to do.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23P01")
}

// affected reports how many rows a statement changed, mapping none to
// ErrNotFound: an update that matched nothing did not happen.
func affected(tag pgconn.CommandTag, err error, what string) error {
	if err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%s: %w", what, domain.ErrNotFound)
	}
	return nil
}

func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

// --- organizations ----------------------------------------------------------

type organizationRepository struct{ q querier }

func (r *organizationRepository) Create(ctx context.Context, o *domain.Organization) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO organizations (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)`,
		pgUUID(o.ID), o.Name, o.CreatedAt, o.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("postgres: create organization: %w", err)
	}
	return nil
}

func (r *organizationRepository) ByID(ctx context.Context, id uuid.UUID) (*domain.Organization, error) {
	row := r.q.QueryRow(ctx,
		`SELECT id, name, created_at, updated_at FROM organizations WHERE id = $1`, pgUUID(id))
	return scanOrganization(row)
}

func (r *organizationRepository) Rename(ctx context.Context, id uuid.UUID, name string, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE organizations SET name = $2, updated_at = $3 WHERE id = $1`, pgUUID(id), name, at)
	return affected(tag, err, "postgres: rename organization")
}

func (r *organizationRepository) Delete(ctx context.Context, id uuid.UUID) error {
	tag, err := r.q.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, pgUUID(id))
	return affected(tag, err, "postgres: delete organization")
}

func scanOrganization(row pgx.Row) (*domain.Organization, error) {
	var (
		o  domain.Organization
		id pgtype.UUID
	)
	if err := row.Scan(&id, &o.Name, &o.CreatedAt, &o.UpdatedAt); err != nil {
		return nil, noRows(err, "postgres: organization")
	}
	o.ID = toUUID(id)
	return &o, nil
}

// --- users ------------------------------------------------------------------

type userRepository struct{ q querier }

const userColumns = `id, email, name, password_hash, created_at, updated_at,
	terms_accepted_at, terms_version, password_changed_at, totp_confirmed_at`

func (r *userRepository) Create(ctx context.Context, u *domain.User) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO users (id, email, name, password_hash, created_at, updated_at,
			terms_accepted_at, terms_version, password_changed_at, totp_confirmed_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		pgUUID(u.ID), u.Email, u.Name, u.PasswordHash, u.CreatedAt, u.UpdatedAt,
		nullTime(u.TermsAcceptedAt), u.TermsVersion, nullTime(u.PasswordChangedAt), nullTime(u.TOTPConfirmedAt),
	)
	if isUniqueViolation(err) {
		return fmt.Errorf("postgres: create user: %w", domain.ErrAlreadyExists)
	}
	if err != nil {
		return fmt.Errorf("postgres: create user: %w", err)
	}
	return nil
}

func (r *userRepository) ByEmail(ctx context.Context, email string) (*domain.User, error) {
	return scanUser(r.q.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE email = $1`, email))
}

func (r *userRepository) ByID(ctx context.Context, id uuid.UUID) (*domain.User, error) {
	return scanUser(r.q.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, pgUUID(id)))
}

func (r *userRepository) UpdatePassword(ctx context.Context, id uuid.UUID, hash string, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE users SET password_hash = $2, password_changed_at = $3, updated_at = $3 WHERE id = $1`,
		pgUUID(id), hash, at)
	return affected(tag, err, "postgres: update password")
}

func (r *userRepository) SetTOTPConfirmed(ctx context.Context, id uuid.UUID, at *time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE users SET totp_confirmed_at = $2, updated_at = now() WHERE id = $1`,
		pgUUID(id), nullTime(at))
	return affected(tag, err, "postgres: set totp")
}

func (r *userRepository) Delete(ctx context.Context, id uuid.UUID) error {
	tag, err := r.q.Exec(ctx, `DELETE FROM users WHERE id = $1`, pgUUID(id))
	return affected(tag, err, "postgres: delete user")
}

func scanUser(row pgx.Row) (*domain.User, error) {
	var (
		u  domain.User
		id pgtype.UUID
	)
	err := row.Scan(&id, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt,
		&u.TermsAcceptedAt, &u.TermsVersion, &u.PasswordChangedAt, &u.TOTPConfirmedAt)
	if err != nil {
		return nil, noRows(err, "postgres: user")
	}
	u.ID = toUUID(id)
	return &u, nil
}

// --- memberships ------------------------------------------------------------

type membershipRepository struct{ q querier }

func (r *membershipRepository) Create(ctx context.Context, m *domain.Membership) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO memberships (organization_id, user_id, role, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		pgUUID(m.OrganizationID), pgUUID(m.UserID), string(m.Role), m.CreatedAt, m.UpdatedAt)
	if isUniqueViolation(err) {
		return fmt.Errorf("postgres: create membership: %w", domain.ErrAlreadyExists)
	}
	if err != nil {
		return fmt.Errorf("postgres: create membership: %w", err)
	}
	return nil
}

func (r *membershipRepository) Get(ctx context.Context, organizationID, userID uuid.UUID) (*domain.Membership, error) {
	var (
		m    domain.Membership
		org  pgtype.UUID
		user pgtype.UUID
		role string
	)
	err := r.q.QueryRow(ctx,
		`SELECT organization_id, user_id, role, created_at, updated_at
		   FROM memberships WHERE organization_id = $1 AND user_id = $2`,
		pgUUID(organizationID), pgUUID(userID),
	).Scan(&org, &user, &role, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return nil, noRows(err, "postgres: membership")
	}
	m.OrganizationID, m.UserID, m.Role = toUUID(org), toUUID(user), domain.Role(role)
	return &m, nil
}

func (r *membershipRepository) ForUser(ctx context.Context, userID uuid.UUID) ([]usecase.MembershipWithOrganization, error) {
	rows, err := r.q.Query(ctx,
		`SELECT o.id, o.name, o.created_at, o.updated_at, m.role, m.created_at
		   FROM memberships m JOIN organizations o ON o.id = m.organization_id
		  WHERE m.user_id = $1
		  ORDER BY o.name`, pgUUID(userID))
	if err != nil {
		return nil, fmt.Errorf("postgres: memberships of user: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (usecase.MembershipWithOrganization, error) {
		var (
			o    domain.Organization
			id   pgtype.UUID
			role string
		)
		var joined time.Time
		if err := row.Scan(&id, &o.Name, &o.CreatedAt, &o.UpdatedAt, &role, &joined); err != nil {
			return usecase.MembershipWithOrganization{}, err
		}
		o.ID = toUUID(id)
		return usecase.MembershipWithOrganization{Organization: &o, Role: domain.Role(role), JoinedAt: joined}, nil
	})
}

func (r *membershipRepository) Members(ctx context.Context, organizationID uuid.UUID) ([]usecase.Member, error) {
	rows, err := r.q.Query(ctx,
		`SELECT `+prefixed(userColumns, "u")+`, m.role, m.created_at
		   FROM memberships m JOIN users u ON u.id = m.user_id
		  WHERE m.organization_id = $1
		  ORDER BY u.name`, pgUUID(organizationID))
	if err != nil {
		return nil, fmt.Errorf("postgres: members: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (usecase.Member, error) {
		var (
			u        domain.User
			id       pgtype.UUID
			role     string
			joinedAt time.Time
		)
		err := row.Scan(&id, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt, &u.UpdatedAt,
			&u.TermsAcceptedAt, &u.TermsVersion, &u.PasswordChangedAt, &u.TOTPConfirmedAt,
			&role, &joinedAt)
		if err != nil {
			return usecase.Member{}, err
		}
		u.ID = toUUID(id)
		return usecase.Member{User: &u, Role: domain.Role(role), JoinedAt: joinedAt}, nil
	})
}

func (r *membershipRepository) UpdateRole(ctx context.Context, organizationID, userID uuid.UUID, role domain.Role, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE memberships SET role = $3, updated_at = $4
		  WHERE organization_id = $1 AND user_id = $2`,
		pgUUID(organizationID), pgUUID(userID), string(role), at)
	return affected(tag, err, "postgres: update role")
}

func (r *membershipRepository) Delete(ctx context.Context, organizationID, userID uuid.UUID) error {
	tag, err := r.q.Exec(ctx,
		`DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2`,
		pgUUID(organizationID), pgUUID(userID))
	return affected(tag, err, "postgres: delete membership")
}

func (r *membershipRepository) CountAdmins(ctx context.Context, organizationID uuid.UUID) (int, error) {
	var count int
	err := r.q.QueryRow(ctx,
		`SELECT count(*) FROM memberships WHERE organization_id = $1 AND role = 'admin'`,
		pgUUID(organizationID)).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("postgres: count admins: %w", err)
	}
	return count, nil
}

func (r *membershipRepository) CountMembers(ctx context.Context, organizationID uuid.UUID) (int, error) {
	var count int
	err := r.q.QueryRow(ctx,
		`SELECT count(*) FROM memberships WHERE organization_id = $1`,
		pgUUID(organizationID)).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("postgres: count members: %w", err)
	}
	return count, nil
}

// prefixed qualifies a column list with a table alias, so one list serves both
// a plain select and a join.
func prefixed(columns, alias string) string {
	parts := strings.Split(columns, ",")
	for i, column := range parts {
		parts[i] = alias + "." + strings.TrimSpace(column)
	}
	return strings.Join(parts, ", ")
}
