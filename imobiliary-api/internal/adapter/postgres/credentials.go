package postgres

import (
	"context"
	"fmt"
	"net/netip"
	"time"
	"uuid"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// --- refresh tokens ---------------------------------------------------------

type sessionRepository struct{ q querier }

const refreshColumns = `id, user_id, organization_id, token_hash, parent_id,
	expires_at, created_at, used_at, revoked_at`

func (r *sessionRepository) Create(ctx context.Context, t *domain.RefreshToken) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO refresh_tokens (id, user_id, organization_id, token_hash, parent_id,
			expires_at, created_at, used_at, revoked_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		pgUUID(t.ID), pgUUID(t.UserID), pgUUID(t.OrganizationID), t.TokenHash,
		pgNullUUID(t.ParentID), t.ExpiresAt, t.CreatedAt, nullTime(t.UsedAt), nullTime(t.RevokedAt))
	if err != nil {
		return fmt.Errorf("postgres: create refresh token: %w", err)
	}
	return nil
}

func (r *sessionRepository) ByHash(ctx context.Context, hash []byte) (*domain.RefreshToken, error) {
	return scanRefreshToken(r.q.QueryRow(ctx,
		`SELECT `+refreshColumns+` FROM refresh_tokens WHERE token_hash = $1`, hash))
}

// Rotate consumes the old token and stores its successor in one transaction.
//
// The UPDATE carries its own condition, so whether the token was still
// unconsumed is decided by the database rather than by a read followed by a
// write. Two requests racing the same secret therefore cannot both succeed:
// the loser changes no row and is reported as a replay, which revokes the
// chain.
func (r *sessionRepository) Rotate(ctx context.Context, previousID uuid.UUID, at time.Time, next *domain.RefreshToken) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE refresh_tokens SET used_at = $2
		  WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
		pgUUID(previousID), at)
	if err != nil {
		return fmt.Errorf("postgres: rotate refresh token: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: rotate refresh token: %w", domain.ErrSessionReused)
	}
	return r.Create(ctx, next)
}

func (r *sessionRepository) Revoke(ctx context.Context, id uuid.UUID, at time.Time) error {
	_, err := r.q.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL`,
		pgUUID(id), at)
	if err != nil {
		return fmt.Errorf("postgres: revoke refresh token: %w", err)
	}
	return nil
}

// RevokeAllForUser ends every session of an account, in every organisation. It
// is what a replayed refresh token, a password change and a removed membership
// all lead to.
func (r *sessionRepository) RevokeAllForUser(ctx context.Context, userID uuid.UUID, at time.Time) error {
	_, err := r.q.Exec(ctx,
		`UPDATE refresh_tokens SET revoked_at = $2
		  WHERE user_id = $1 AND revoked_at IS NULL AND used_at IS NULL`,
		pgUUID(userID), at)
	if err != nil {
		return fmt.Errorf("postgres: revoke sessions: %w", err)
	}
	return nil
}

func (r *sessionRepository) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	tag, err := r.q.Exec(ctx, `DELETE FROM refresh_tokens WHERE expires_at < $1`, before)
	if err != nil {
		return 0, fmt.Errorf("postgres: purge refresh tokens: %w", err)
	}
	return tag.RowsAffected(), nil
}

func scanRefreshToken(row pgx.Row) (*domain.RefreshToken, error) {
	var (
		t                   domain.RefreshToken
		id, user, org, prnt pgtype.UUID
	)
	err := row.Scan(&id, &user, &org, &t.TokenHash, &prnt,
		&t.ExpiresAt, &t.CreatedAt, &t.UsedAt, &t.RevokedAt)
	if err != nil {
		return nil, noRows(err, "postgres: refresh token")
	}
	t.ID, t.UserID, t.OrganizationID, t.ParentID = toUUID(id), toUUID(user), toUUID(org), toNullUUID(prnt)
	return &t, nil
}

// --- password resets --------------------------------------------------------

type passwordResetRepository struct{ q querier }

func (r *passwordResetRepository) Create(ctx context.Context, reset *domain.PasswordReset) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		pgUUID(reset.ID), pgUUID(reset.UserID), reset.TokenHash, reset.ExpiresAt, reset.CreatedAt)
	if err != nil {
		return fmt.Errorf("postgres: create password reset: %w", err)
	}
	return nil
}

func (r *passwordResetRepository) ByHash(ctx context.Context, hash []byte) (*domain.PasswordReset, error) {
	var (
		reset    domain.PasswordReset
		id, user pgtype.UUID
	)
	err := r.q.QueryRow(ctx,
		`SELECT id, user_id, token_hash, expires_at, created_at, used_at
		   FROM password_resets WHERE token_hash = $1`, hash,
	).Scan(&id, &user, &reset.TokenHash, &reset.ExpiresAt, &reset.CreatedAt, &reset.UsedAt)
	if err != nil {
		return nil, noRows(err, "postgres: password reset")
	}
	reset.ID, reset.UserID = toUUID(id), toUUID(user)
	return &reset, nil
}

// Consume spends a reset link. The condition is in the statement, so two
// requests carrying the same link cannot both set a password.
func (r *passwordResetRepository) Consume(ctx context.Context, id uuid.UUID, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE password_resets SET used_at = $2 WHERE id = $1 AND used_at IS NULL`,
		pgUUID(id), at)
	return affected(tag, err, "postgres: consume password reset")
}

// InvalidateForUser spends every outstanding link of an account, which is what
// a completed reset or a password change does to the ones still in inboxes.
func (r *passwordResetRepository) InvalidateForUser(ctx context.Context, userID uuid.UUID, at time.Time) error {
	_, err := r.q.Exec(ctx,
		`UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL`,
		pgUUID(userID), at)
	if err != nil {
		return fmt.Errorf("postgres: invalidate password resets: %w", err)
	}
	return nil
}

func (r *passwordResetRepository) DeleteExpired(ctx context.Context, before time.Time) (int64, error) {
	tag, err := r.q.Exec(ctx, `DELETE FROM password_resets WHERE expires_at < $1`, before)
	if err != nil {
		return 0, fmt.Errorf("postgres: purge password resets: %w", err)
	}
	return tag.RowsAffected(), nil
}

// --- invitations ------------------------------------------------------------

type invitationRepository struct{ q querier }

const invitationColumns = `id, organization_id, email, role, token_hash, invited_by,
	expires_at, created_at, accepted_at, revoked_at`

func (r *invitationRepository) Create(ctx context.Context, i *domain.Invitation) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by,
			expires_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		pgUUID(i.ID), pgUUID(i.OrganizationID), i.Email, string(i.Role), i.TokenHash,
		pgUUID(i.InvitedBy), i.ExpiresAt, i.CreatedAt)
	if isUniqueViolation(err) {
		return fmt.Errorf("postgres: create invitation: %w", domain.ErrAlreadyExists)
	}
	if err != nil {
		return fmt.Errorf("postgres: create invitation: %w", err)
	}
	return nil
}

func (r *invitationRepository) ByHash(ctx context.Context, hash []byte) (*domain.Invitation, error) {
	return scanInvitation(r.q.QueryRow(ctx,
		`SELECT `+invitationColumns+` FROM invitations WHERE token_hash = $1`, hash))
}

// ByID takes the organisation as well as the identifier, so an admin of one
// office cannot reach another's invitation by guessing a UUID.
func (r *invitationRepository) ByID(ctx context.Context, organizationID, id uuid.UUID) (*domain.Invitation, error) {
	return scanInvitation(r.q.QueryRow(ctx,
		`SELECT `+invitationColumns+` FROM invitations WHERE organization_id = $1 AND id = $2`,
		pgUUID(organizationID), pgUUID(id)))
}

func (r *invitationRepository) ForOrganization(ctx context.Context, organizationID uuid.UUID) ([]*domain.Invitation, error) {
	rows, err := r.q.Query(ctx,
		`SELECT `+invitationColumns+` FROM invitations
		  WHERE organization_id = $1 ORDER BY created_at DESC`, pgUUID(organizationID))
	if err != nil {
		return nil, fmt.Errorf("postgres: invitations: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (*domain.Invitation, error) {
		return scanInvitation(row)
	})
}

func (r *invitationRepository) Accept(ctx context.Context, id uuid.UUID, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE invitations SET accepted_at = $2
		  WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2`,
		pgUUID(id), at)
	return affected(tag, err, "postgres: accept invitation")
}

func (r *invitationRepository) Revoke(ctx context.Context, id uuid.UUID, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE invitations SET revoked_at = $2
		  WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
		pgUUID(id), at)
	return affected(tag, err, "postgres: revoke invitation")
}

func scanInvitation(row pgx.Row) (*domain.Invitation, error) {
	var (
		i           domain.Invitation
		id, org, by pgtype.UUID
		role        string
	)
	err := row.Scan(&id, &org, &i.Email, &role, &i.TokenHash, &by,
		&i.ExpiresAt, &i.CreatedAt, &i.AcceptedAt, &i.RevokedAt)
	if err != nil {
		return nil, noRows(err, "postgres: invitation")
	}
	i.ID, i.OrganizationID, i.Role = toUUID(id), toUUID(org), domain.Role(role)
	if by.Valid {
		i.InvitedBy = toUUID(by)
	}
	return &i, nil
}

// --- the second factor ------------------------------------------------------

type mfaRepository struct{ q querier }

// SaveEnrollment stores a new, unconfirmed enrolment, replacing any previous
// attempt: someone who starts the setup twice has one secret, the last.
func (r *mfaRepository) SaveEnrollment(ctx context.Context, e *domain.TOTPEnrollment) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO user_totp (user_id, secret, last_used_step, created_at, confirmed_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (user_id) DO UPDATE
		 SET secret = EXCLUDED.secret, last_used_step = EXCLUDED.last_used_step,
		     created_at = EXCLUDED.created_at, confirmed_at = EXCLUDED.confirmed_at`,
		pgUUID(e.UserID), e.Secret, e.LastUsedStep, e.CreatedAt, nullTime(e.ConfirmedAt))
	if err != nil {
		return fmt.Errorf("postgres: save totp enrollment: %w", err)
	}
	return nil
}

func (r *mfaRepository) Enrollment(ctx context.Context, userID uuid.UUID) (*domain.TOTPEnrollment, error) {
	var (
		e    domain.TOTPEnrollment
		user pgtype.UUID
	)
	err := r.q.QueryRow(ctx,
		`SELECT user_id, secret, last_used_step, created_at, confirmed_at FROM user_totp WHERE user_id = $1`,
		pgUUID(userID),
	).Scan(&user, &e.Secret, &e.LastUsedStep, &e.CreatedAt, &e.ConfirmedAt)
	if err != nil {
		return nil, noRows(err, "postgres: totp enrollment")
	}
	e.UserID = toUUID(user)
	return &e, nil
}

func (r *mfaRepository) Confirm(ctx context.Context, userID uuid.UUID, at time.Time, step int64) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE user_totp SET confirmed_at = $2, last_used_step = $3 WHERE user_id = $1`,
		pgUUID(userID), at, step)
	return affected(tag, err, "postgres: confirm totp")
}

func (r *mfaRepository) RecordStep(ctx context.Context, userID uuid.UUID, step int64) error {
	// The condition keeps the recorded step monotonic: two requests arriving
	// together must not let the later one lower it and reopen a replay.
	_, err := r.q.Exec(ctx,
		`UPDATE user_totp SET last_used_step = $2 WHERE user_id = $1 AND last_used_step < $2`,
		pgUUID(userID), step)
	if err != nil {
		return fmt.Errorf("postgres: record totp step: %w", err)
	}
	return nil
}

func (r *mfaRepository) DeleteEnrollment(ctx context.Context, userID uuid.UUID) error {
	if _, err := r.q.Exec(ctx, `DELETE FROM user_totp WHERE user_id = $1`, pgUUID(userID)); err != nil {
		return fmt.Errorf("postgres: delete totp enrollment: %w", err)
	}
	if _, err := r.q.Exec(ctx, `DELETE FROM recovery_codes WHERE user_id = $1`, pgUUID(userID)); err != nil {
		return fmt.Errorf("postgres: delete recovery codes: %w", err)
	}
	return nil
}

// ReplaceRecoveryCodes swaps the whole set: generating new codes always
// invalidates the old ones, so a list printed months ago cannot be used after
// a new one was handed out.
func (r *mfaRepository) ReplaceRecoveryCodes(ctx context.Context, userID uuid.UUID, hashes [][]byte) error {
	if _, err := r.q.Exec(ctx, `DELETE FROM recovery_codes WHERE user_id = $1`, pgUUID(userID)); err != nil {
		return fmt.Errorf("postgres: clear recovery codes: %w", err)
	}
	for _, hash := range hashes {
		_, err := r.q.Exec(ctx,
			`INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`,
			pgUUID(uuid.NewV7()), pgUUID(userID), hash)
		if err != nil {
			return fmt.Errorf("postgres: store recovery code: %w", err)
		}
	}
	return nil
}

// ConsumeRecoveryCode spends one code. The condition is in the statement, so
// the same code presented twice at once is accepted once.
func (r *mfaRepository) ConsumeRecoveryCode(ctx context.Context, userID uuid.UUID, hash []byte, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE recovery_codes SET used_at = $3
		  WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
		pgUUID(userID), hash, at)
	return affected(tag, err, "postgres: consume recovery code")
}

func (r *mfaRepository) CountUnusedRecoveryCodes(ctx context.Context, userID uuid.UUID) (int, error) {
	var count int
	err := r.q.QueryRow(ctx,
		`SELECT count(*) FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
		pgUUID(userID)).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("postgres: count recovery codes: %w", err)
	}
	return count, nil
}

func (r *mfaRepository) CreateChallenge(ctx context.Context, c *domain.MFAChallenge) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO mfa_challenges (id, user_id, token_hash, expires_at, created_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		pgUUID(c.ID), pgUUID(c.UserID), c.TokenHash, c.ExpiresAt, c.CreatedAt)
	if err != nil {
		return fmt.Errorf("postgres: create mfa challenge: %w", err)
	}
	return nil
}

func (r *mfaRepository) ChallengeByHash(ctx context.Context, hash []byte) (*domain.MFAChallenge, error) {
	var (
		c        domain.MFAChallenge
		id, user pgtype.UUID
	)
	err := r.q.QueryRow(ctx,
		`SELECT id, user_id, token_hash, expires_at, created_at, used_at
		   FROM mfa_challenges WHERE token_hash = $1`, hash,
	).Scan(&id, &user, &c.TokenHash, &c.ExpiresAt, &c.CreatedAt, &c.UsedAt)
	if err != nil {
		return nil, noRows(err, "postgres: mfa challenge")
	}
	c.ID, c.UserID = toUUID(id), toUUID(user)
	return &c, nil
}

func (r *mfaRepository) ConsumeChallenge(ctx context.Context, id uuid.UUID, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE mfa_challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL`,
		pgUUID(id), at)
	return affected(tag, err, "postgres: consume mfa challenge")
}

// --- the two records --------------------------------------------------------

type auditRepository struct{ q querier }

func (r *auditRepository) Record(ctx context.Context, e *domain.AuditEvent) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO audit_events (id, organization_id, actor_id, action, entity_type,
			entity_id, fields, request_id, ip, occurred_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		pgUUID(e.ID), pgNullUUID(e.OrganizationID), pgNullUUID(e.ActorID), string(e.Action),
		e.EntityType, pgNullUUID(e.EntityID), e.Fields, e.RequestID, nullAddr(e.IP), e.OccurredAt)
	if err != nil {
		return fmt.Errorf("postgres: record audit event: %w", err)
	}
	return nil
}

func (r *auditRepository) RecordAccess(ctx context.Context, rec *domain.AccessRecord) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO access_records (id, user_id, event, ip, port, occurred_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		pgUUID(rec.ID), pgNullUUID(rec.UserID), string(rec.Event), nullAddr(rec.IP), rec.Port, rec.OccurredAt)
	if err != nil {
		return fmt.Errorf("postgres: record access: %w", err)
	}
	return nil
}

func (r *auditRepository) PurgeAccessRecords(ctx context.Context, before time.Time) (int64, error) {
	tag, err := r.q.Exec(ctx, `DELETE FROM access_records WHERE occurred_at < $1`, before)
	if err != nil {
		return 0, fmt.Errorf("postgres: purge access records: %w", err)
	}
	return tag.RowsAffected(), nil
}

func nullAddr(addr *netip.Addr) any {
	if addr == nil || !addr.IsValid() {
		return nil
	}
	return *addr
}

// Compile-time proof that every repository satisfies the port the use cases
// declared. A mismatch is a build error here rather than a nil interface at
// start-up.
var (
	_ usecase.OrganizationRepository  = (*organizationRepository)(nil)
	_ usecase.UserRepository          = (*userRepository)(nil)
	_ usecase.MembershipRepository    = (*membershipRepository)(nil)
	_ usecase.SessionRepository       = (*sessionRepository)(nil)
	_ usecase.PasswordResetRepository = (*passwordResetRepository)(nil)
	_ usecase.InvitationRepository    = (*invitationRepository)(nil)
	_ usecase.MFARepository           = (*mfaRepository)(nil)
	_ usecase.AuditRepository         = (*auditRepository)(nil)
	_ usecase.Transactor              = (*DB)(nil)
)
