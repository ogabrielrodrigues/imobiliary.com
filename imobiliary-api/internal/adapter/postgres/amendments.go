package postgres

import (
	"context"
	"fmt"
	"time"
	"uuid"

	"github.com/jackc/pgx/v5/pgtype"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

type amendmentRepository struct {
	q              querier
	organizationID uuid.UUID
}

var _ usecase.AmendmentRepository = (*amendmentRepository)(nil)

func (r *amendmentRepository) List(ctx context.Context, contractID uuid.UUID) ([]domain.Amendment, error) {
	rows, err := r.q.Query(ctx,
		`SELECT id, contract_id, amended_on, adjustment_index, index_rate, previous_rent, indexed_rent,
		        period_acknowledged_by, period_acknowledged_at, created_at
		   FROM amendments WHERE contract_id = $1 ORDER BY amended_on`, pgUUID(contractID))
	if err != nil {
		return nil, fmt.Errorf("postgres: list amendments: %w", err)
	}
	defer rows.Close()
	var out []domain.Amendment
	for rows.Next() {
		var (
			a                 domain.Amendment
			id, contract, by  pgtype.UUID
			on                pgtype.Date
			index             string
			rate              int32
			previous, indexed int64
			at                pgtype.Timestamptz
		)
		if err := rows.Scan(&id, &contract, &on, &index, &rate, &previous, &indexed, &by, &at, &a.CreatedAt); err != nil {
			return nil, fmt.Errorf("postgres: list amendments: %w", err)
		}
		a.ID, a.ContractID, a.AmendedOn = toUUID(id), toUUID(contract), toDate(on)
		a.Index, a.IndexRate = domain.AdjustmentIndex(index), domain.Rate(rate)
		a.PreviousRent, a.IndexedRent = domain.Money(previous), domain.Money(indexed)
		a.PeriodAcknowledgedBy = toNullUUID(by)
		if at.Valid {
			t := at.Time
			a.PeriodAcknowledgedAt = &t
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// setRent moves the contract to a rent as of version and rewrites the unpaid
// instalments from sequence on.
func (r *amendmentRepository) setRent(ctx context.Context, contractID uuid.UUID, rent domain.Money, version, from int, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE contracts SET current_rent = $2, version = version + 1, updated_at = $3
		  WHERE id = $1 AND version = $4 AND terminated_on IS NULL`,
		pgUUID(contractID), int64(rent), at, version)
	if err != nil {
		return fmt.Errorf("postgres: adjust contract rent: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: adjust contract rent: %w", domain.ErrPreconditionFailed)
	}
	if _, err := r.q.Exec(ctx,
		`UPDATE rents SET rent_amount = $3 WHERE contract_id = $1 AND sequence >= $2 AND paid_on IS NULL`,
		pgUUID(contractID), from, int64(rent)); err != nil {
		return fmt.Errorf("postgres: adjust rents: %w", err)
	}
	return nil
}

func (r *amendmentRepository) Create(ctx context.Context, a *domain.Amendment, version, from int) error {
	if err := r.setRent(ctx, a.ContractID, a.IndexedRent, version, from, a.CreatedAt); err != nil {
		return err
	}
	_, err := r.q.Exec(ctx,
		`INSERT INTO amendments (id, organization_id, contract_id, amended_on, adjustment_index, index_rate,
		                         previous_rent, indexed_rent, period_acknowledged_by, period_acknowledged_at, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		pgUUID(a.ID), pgUUID(r.organizationID), pgUUID(a.ContractID), pgDate(a.AmendedOn), string(a.Index),
		int32(a.IndexRate), int64(a.PreviousRent), int64(a.IndexedRent), pgNullUUID(a.PeriodAcknowledgedBy),
		a.PeriodAcknowledgedAt, a.CreatedAt)
	if err != nil {
		return fmt.Errorf("postgres: create amendment: %w", err)
	}
	return nil
}

func (r *amendmentRepository) Delete(ctx context.Context, a *domain.Amendment, version, from int, at time.Time) error {
	if err := r.setRent(ctx, a.ContractID, a.PreviousRent, version, from, at); err != nil {
		return err
	}
	if _, err := r.q.Exec(ctx, `DELETE FROM amendments WHERE id = $1`, pgUUID(a.ID)); err != nil {
		return fmt.Errorf("postgres: delete amendment: %w", err)
	}
	return nil
}
