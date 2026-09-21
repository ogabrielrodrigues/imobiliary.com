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

type rentRepository struct {
	q              querier
	organizationID uuid.UUID
}

var _ usecase.RentRepository = (*rentRepository)(nil)

const rentSelect = `SELECT r.id, r.contract_id, c.registry,
	       a.street, a.number, a.complement, a.district, a.city, a.state,
	       ARRAY(SELECT p.name FROM contract_parties cp JOIN people p ON p.id = cp.person_id
	              WHERE cp.contract_id = c.id AND cp.role = 'tenant' ORDER BY cp.position),
	       r.sequence, r.due_on, r.rent_amount,
	       COALESCE((SELECT sum(rc.amount) FROM rent_charges rc WHERE rc.rent_id = r.id), 0)::bigint,
	       r.late_fee, r.amount_paid, r.paid_on, c.late_penalty_rate, c.late_interest_rate, r.income_tax_withheld
	  FROM rents r
	  JOIN contracts c ON c.id = r.contract_id
	  JOIN properties pr ON pr.id = c.property_id
	  JOIN addresses a ON a.id = pr.address_id`

func scanRent(row pgx.Row) (*usecase.RentView, error) {
	var (
		v                    usecase.RentView
		id, contract         pgtype.UUID
		due, paid            pgtype.Date
		amount, charges, fee int64
		amountPaid           pgtype.Int8
		penalty, interest    int32
		tax                  int64
	)
	err := row.Scan(&id, &contract, &v.Registry, &v.Address.Street, &v.Address.Number, &v.Address.Complement,
		&v.Address.District, &v.Address.City, &v.Address.State, &v.TenantNames, &v.Sequence, &due, &amount,
		&charges, &fee, &amountPaid, &paid, &penalty, &interest, &tax)
	if err != nil {
		return nil, err
	}
	v.ID, v.ContractID, v.DueOn, v.PaidOn = toUUID(id), toUUID(contract), toDate(due), toNullDate(paid)
	v.Amount, v.ChargesTotal, v.LateFee = domain.Money(amount), domain.Money(charges), domain.Money(fee)
	v.LatePenaltyRate, v.LateInterestRate = domain.Rate(penalty), domain.Rate(interest)
	v.IncomeTaxWithheld = domain.Money(tax)
	if amountPaid.Valid {
		m := domain.Money(amountPaid.Int64)
		v.AmountPaid = &m
	}
	if v.TenantNames == nil {
		v.TenantNames = []string{}
	}
	return &v, nil
}

func (r *rentRepository) List(ctx context.Context, q usecase.RentQuery) ([]usecase.RentView, error) {
	var (
		where []string
		args  []any
	)
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if q.Search != "" {
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q.Search)
		pattern := "'%' || immutable_unaccent(lower(" + arg(escaped) + ")) || '%'"
		where = append(where, "(immutable_unaccent(lower(c.registry)) LIKE "+pattern+
			" OR immutable_unaccent(lower(a.street)) LIKE "+pattern+
			" OR EXISTS (SELECT 1 FROM contract_parties cp JOIN people p ON p.id = cp.person_id"+
			" WHERE cp.contract_id = c.id AND immutable_unaccent(lower(p.name)) LIKE "+pattern+"))")
	}
	switch q.Status {
	case "overdue":
		where = append(where, "r.paid_on IS NULL AND r.due_on < "+arg(pgDate(q.Today)))
	case "pending":
		where = append(where, "r.paid_on IS NULL AND r.due_on >= "+arg(pgDate(q.Today)))
	case "open":
		where = append(where, "r.paid_on IS NULL")
	case "paid":
		where = append(where, "r.paid_on IS NOT NULL")
	}
	if q.DueFrom != nil {
		where = append(where, "r.due_on >= "+arg(pgDate(*q.DueFrom)))
	}
	if q.DueTo != nil {
		where = append(where, "r.due_on <= "+arg(pgDate(*q.DueTo)))
	}
	if q.ContractID != nil {
		where = append(where, "r.contract_id = "+arg(pgUUID(*q.ContractID)))
	}
	if q.After != nil {
		where = append(where, "(r.due_on, r.id) > ("+arg(pgDate(q.After.DueOn))+", "+arg(pgUUID(q.After.ID))+")")
	}
	sql := rentSelect
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY r.due_on, r.id LIMIT " + arg(q.Limit)

	rows, err := r.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("postgres: list rents: %w", err)
	}
	defer rows.Close()
	var out []usecase.RentView
	for rows.Next() {
		v, err := scanRent(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: list rents: %w", err)
		}
		out = append(out, *v)
	}
	return out, rows.Err()
}

func (r *rentRepository) Get(ctx context.Context, id uuid.UUID) (*usecase.RentView, error) {
	v, err := scanRent(r.q.QueryRow(ctx, rentSelect+` WHERE r.id = $1`, pgUUID(id)))
	if err != nil {
		return nil, noRows(err, "postgres: rent")
	}
	rows, err := r.q.Query(ctx,
		`SELECT id, kind, description, amount, destination FROM rent_charges WHERE rent_id = $1 ORDER BY created_at, id`, pgUUID(id))
	if err != nil {
		return nil, fmt.Errorf("postgres: rent charges: %w", err)
	}
	v.Charges, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Charge, error) {
		var (
			c      domain.Charge
			cid    pgtype.UUID
			kind   string
			amount int64
			dest   string
		)
		err := row.Scan(&cid, &kind, &c.Description, &amount, &dest)
		c.ID, c.RentID, c.Kind, c.Amount = toUUID(cid), id, domain.ChargeKind(kind), domain.Money(amount)
		c.Destination = domain.ChargeDestination(dest)
		return c, err
	})
	if err != nil {
		return nil, fmt.Errorf("postgres: rent charges: %w", err)
	}
	return v, nil
}

// settled explains an update that touched no row: the rent is missing, or it
// is not in the state the update needs.
func (r *rentRepository) settled(ctx context.Context, id uuid.UUID, what string) error {
	var exists bool
	if err := r.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM rents WHERE id = $1)`, pgUUID(id)).Scan(&exists); err != nil {
		return fmt.Errorf("postgres: %s: %w", what, err)
	}
	if !exists {
		return fmt.Errorf("postgres: %s: %w", what, domain.ErrNotFound)
	}
	return fmt.Errorf("postgres: %s: %w", what, domain.ErrConflict)
}

func (r *rentRepository) Pay(ctx context.Context, id uuid.UUID, p domain.Payment) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE rents SET paid_on = $2, amount_paid = $3, late_fee = $4, income_tax_withheld = $5
		  WHERE id = $1 AND paid_on IS NULL`,
		pgUUID(id), pgDate(p.PaidOn), int64(p.AmountPaid), int64(p.LateFee), int64(p.IncomeTax))
	if err != nil {
		return fmt.Errorf("postgres: pay rent: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return r.settled(ctx, id, "pay rent")
	}
	return nil
}

func (r *rentRepository) Reverse(ctx context.Context, id uuid.UUID) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE rents SET paid_on = NULL, amount_paid = NULL, late_fee = 0, income_tax_withheld = 0
		  WHERE id = $1 AND paid_on IS NOT NULL`,
		pgUUID(id))
	if err != nil {
		return fmt.Errorf("postgres: reverse payment: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return r.settled(ctx, id, "reverse payment")
	}
	return nil
}

func (r *rentRepository) AddCharge(ctx context.Context, c *domain.Charge, at time.Time) error {
	tag, err := r.q.Exec(ctx,
		`INSERT INTO rent_charges (id, organization_id, rent_id, kind, description, amount, destination, created_at)
		 SELECT $1, $2, $3, $4, $5, $6, $7, $8 WHERE EXISTS (SELECT 1 FROM rents WHERE id = $3 AND paid_on IS NULL)`,
		pgUUID(c.ID), pgUUID(r.organizationID), pgUUID(c.RentID), string(c.Kind), c.Description, int64(c.Amount),
		string(c.Destination), at)
	if err != nil {
		return fmt.Errorf("postgres: add charge: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return r.settled(ctx, c.RentID, "add charge")
	}
	return nil
}

func (r *rentRepository) RemoveCharge(ctx context.Context, rentID, chargeID uuid.UUID) error {
	tag, err := r.q.Exec(ctx,
		`DELETE FROM rent_charges rc USING rents r
		  WHERE rc.id = $2 AND rc.rent_id = $1 AND r.id = rc.rent_id AND r.paid_on IS NULL`,
		pgUUID(rentID), pgUUID(chargeID))
	if err != nil {
		return fmt.Errorf("postgres: remove charge: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: remove charge: %w", domain.ErrNotFound)
	}
	return nil
}

func (r *rentRepository) HasCharges(ctx context.Context, contractID uuid.UUID) (bool, error) {
	var has bool
	err := r.q.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM rent_charges rc JOIN rents r ON r.id = rc.rent_id WHERE r.contract_id = $1)`,
		pgUUID(contractID)).Scan(&has)
	if err != nil {
		return false, fmt.Errorf("postgres: contract charges: %w", err)
	}
	return has, nil
}

func (r *rentRepository) SetChargeDestination(ctx context.Context, rentID, chargeID uuid.UUID, d domain.ChargeDestination) error {
	tag, err := r.q.Exec(ctx, `UPDATE rent_charges SET destination = $3 WHERE rent_id = $1 AND id = $2`,
		pgUUID(rentID), pgUUID(chargeID), string(d))
	return affected(tag, err, "postgres: charge destination")
}

func (r *rentRepository) PaidWithoutEntries(ctx context.Context) ([]uuid.UUID, error) {
	rows, err := r.q.Query(ctx,
		`SELECT r.id FROM rents r
		  WHERE r.paid_on IS NOT NULL
		    AND NOT EXISTS (SELECT 1 FROM owner_entries e WHERE e.rent_id = r.id)
		  ORDER BY r.paid_on, r.id`)
	if err != nil {
		return nil, fmt.Errorf("postgres: rents without lines: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[pgtype.UUID])
	if err != nil {
		return nil, fmt.Errorf("postgres: rents without lines: %w", err)
	}
	out := make([]uuid.UUID, len(ids))
	for i, id := range ids {
		out[i] = toUUID(id)
	}
	return out, nil
}

// --- dashboard ------------------------------------------------------------------

type dashboardRepository struct {
	q querier
}

var _ usecase.DashboardRepository = (*dashboardRepository)(nil)

// Every contract counted as running is neither terminated nor outside its term today.
const runningContract = `c.terminated_on IS NULL AND $1::date BETWEEN c.starts_on AND c.expires_on`

func (d *dashboardRepository) Month(ctx context.Context, from, to domain.Date) (usecase.MonthFigures, error) {
	var (
		f                                      usecase.MonthFigures
		expected, received, open, fee, paidOut int64
	)
	err := d.q.QueryRow(ctx,
		`WITH due AS (
		     SELECT r.paid_on, r.rent_amount
		            + COALESCE((SELECT sum(rc.amount) FROM rent_charges rc WHERE rc.rent_id = r.id), 0) AS amount
		       FROM rents r WHERE r.due_on BETWEEN $1 AND $2
		 ), paid AS (
		     SELECT r.amount_paid FROM rents r WHERE r.paid_on BETWEEN $1 AND $2
		 )
		 SELECT (SELECT COALESCE(sum(amount), 0)::bigint FROM due),
		        (SELECT count(*) FROM due),
		        (SELECT COALESCE(sum(amount_paid), 0)::bigint FROM paid),
		        (SELECT count(*) FROM paid),
		        (SELECT COALESCE(sum(amount), 0)::bigint FROM due WHERE paid_on IS NULL),
		        (SELECT count(*) FROM due WHERE paid_on IS NULL),
		        -- The fee is what the ledger charged the owners on the rents
		        -- received in the month: the rent and the owner's charges.
		        (SELECT COALESCE(-sum(e.amount), 0)::bigint FROM owner_entries e
		          WHERE e.kind = 'admin_fee' AND e.occurred_on BETWEEN $1 AND $2),
		        (SELECT COALESCE(sum(total), 0)::bigint FROM payouts WHERE paid_on BETWEEN $1 AND $2),
		        (SELECT count(*) FROM payouts WHERE paid_on BETWEEN $1 AND $2)`,
		pgDate(from), pgDate(to)).Scan(&expected, &f.ExpectedCount, &received, &f.ReceivedCount, &open, &f.OpenCount, &fee,
		&paidOut, &f.PaidOutCount)
	if err != nil {
		return f, fmt.Errorf("postgres: month figures: %w", err)
	}
	f.Expected, f.Received, f.Open, f.OfficeFee = domain.Money(expected), domain.Money(received), domain.Money(open), domain.Money(fee)
	f.PaidOut = domain.Money(paidOut)
	return f, nil
}

func (d *dashboardRepository) Overdue(ctx context.Context, today domain.Date) (int, domain.Money, error) {
	var (
		count  int
		amount int64
	)
	err := d.q.QueryRow(ctx,
		`SELECT count(*), COALESCE(sum(r.rent_amount
		        + COALESCE((SELECT sum(rc.amount) FROM rent_charges rc WHERE rc.rent_id = r.id), 0)), 0)::bigint
		   FROM rents r WHERE r.paid_on IS NULL AND r.due_on < $1`, pgDate(today)).Scan(&count, &amount)
	if err != nil {
		return 0, 0, fmt.Errorf("postgres: overdue figures: %w", err)
	}
	return count, domain.Money(amount), nil
}

func (d *dashboardRepository) Portfolio(ctx context.Context, today domain.Date) (usecase.Portfolio, error) {
	var (
		p    usecase.Portfolio
		roll int64
	)
	err := d.q.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM properties),
		        (SELECT count(DISTINCT c.property_id) FROM contracts c WHERE `+runningContract+`),
		        (SELECT count(*) FROM contracts c WHERE `+runningContract+`),
		        (SELECT COALESCE(sum(c.current_rent), 0)::bigint FROM contracts c WHERE `+runningContract+`)`,
		pgDate(today)).Scan(&p.Properties, &p.LeasedProperties, &p.ActiveContracts, &roll)
	if err != nil {
		return p, fmt.Errorf("postgres: portfolio: %w", err)
	}
	p.RentRoll = domain.Money(roll)
	return p, nil
}

func (d *dashboardRepository) deadlines(ctx context.Context, sql string, args ...any) ([]usecase.ContractDeadline, error) {
	rows, err := d.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("postgres: deadlines: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (usecase.ContractDeadline, error) {
		var (
			v  usecase.ContractDeadline
			id pgtype.UUID
			on pgtype.Date
		)
		err := row.Scan(&id, &v.Registry, &v.Address.Street, &v.Address.Number, &v.Address.Complement,
			&v.Address.District, &v.Address.City, &v.Address.State, &on)
		v.ContractID, v.On = toUUID(id), toDate(on)
		return v, err
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("postgres: deadlines: %w", err)
	}
	return out, nil
}

func (d *dashboardRepository) Expiring(ctx context.Context, today, until domain.Date, limit int) ([]usecase.ContractDeadline, error) {
	return d.deadlines(ctx,
		`SELECT c.id, c.registry, a.street, a.number, a.complement, a.district, a.city, a.state, c.expires_on
		   FROM contracts c
		   JOIN properties pr ON pr.id = c.property_id
		   JOIN addresses a ON a.id = pr.address_id
		  WHERE `+runningContract+` AND c.expires_on <= $2
		  ORDER BY c.expires_on, c.id LIMIT $3`,
		pgDate(today), pgDate(until), limit)
}

func (d *dashboardRepository) AdjustmentsDue(ctx context.Context, today, until domain.Date, limit int) ([]usecase.ContractDeadline, error) {
	return d.deadlines(ctx,
		`SELECT id, registry, street, number, complement, district, city, state, due FROM (
		     SELECT c.id, c.registry, a.street, a.number, a.complement, a.district, a.city, a.state,
		            (COALESCE((SELECT max(am.amended_on) FROM amendments am WHERE am.contract_id = c.id), c.starts_on)
		             + interval '12 months')::date AS due
		       FROM contracts c
		       JOIN properties pr ON pr.id = c.property_id
		       JOIN addresses a ON a.id = pr.address_id
		      WHERE `+runningContract+` AND c.adjustment_index <> ''
		 ) d
		  WHERE due <= $2
		  ORDER BY due, id LIMIT $3`,
		pgDate(today), pgDate(until), limit)
}

func (d *dashboardRepository) Payouts(ctx context.Context) (usecase.PayoutFigures, error) {
	var (
		f       usecase.PayoutFigures
		pending int64
	)
	err := d.q.QueryRow(ctx,
		`SELECT COALESCE(sum(balance), 0)::bigint, count(*)
		   FROM (SELECT sum(amount) AS balance FROM owner_entries WHERE payout_id IS NULL GROUP BY person_id) b
		  WHERE balance > 0`).Scan(&pending, &f.Beneficiaries)
	if err != nil {
		return f, fmt.Errorf("postgres: payout figures: %w", err)
	}
	f.Pending = domain.Money(pending)
	return f, nil
}
