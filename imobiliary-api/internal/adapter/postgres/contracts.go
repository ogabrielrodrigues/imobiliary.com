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

type contractRepository struct {
	q              querier
	organizationID uuid.UUID
}

func pgDate(d domain.Date) pgtype.Date { return pgtype.Date{Time: d.Time(), Valid: true} }

func pgNullDate(d *domain.Date) pgtype.Date {
	if d == nil {
		return pgtype.Date{}
	}
	return pgDate(*d)
}

func toDate(v pgtype.Date) domain.Date { return domain.DateOf(v.Time, time.UTC) }

func toNullDate(v pgtype.Date) *domain.Date {
	if !v.Valid {
		return nil
	}
	d := toDate(v)
	return &d
}

// contractConflict turns the constraints a form can do something about into
// field errors: another lease of the property in the same period, or a
// registry number already used by the office.
func contractConflict(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	v := &domain.ValidationError{}
	switch {
	case pgErr.Code == "23P01":
		v.Add("starts_on", "the property already has a contract in this period")
	case pgErr.Code == "23505" && strings.Contains(pgErr.ConstraintName, "registry"):
		v.Add("registry", "is already used by another contract")
	case isForeignKeyViolation(err):
		v.Add("parties", "names a person or property that does not exist")
	default:
		return err
	}
	return v
}

func (r *contractRepository) Create(ctx context.Context, c *domain.Contract, schedule []domain.Instalment) error {
	_, err := r.q.Exec(ctx,
		`INSERT INTO contracts (id, organization_id, property_id, registry, guarantee_kind, deposit_amount,
			rent, current_rent, admin_fee, late_penalty_rate, late_interest_rate, due_day, adjustment_index,
			signed_on, starts_on, expires_on, terminated_on, version, created_at, updated_at, advance_rent)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NULL, 1, $17, $17, $18)`,
		pgUUID(c.ID), pgUUID(r.organizationID), pgUUID(c.PropertyID), c.Registry, string(c.GuaranteeKind),
		int64(c.DepositAmount), int64(c.Rent), int64(c.CurrentRent), int32(c.AdminFee),
		int32(c.LatePenaltyRate), int32(c.LateInterestRate), c.DueDay, string(c.AdjustmentIndex),
		pgDate(c.SignedOn), pgDate(c.StartsOn), pgDate(c.ExpiresOn), c.CreatedAt, c.AdvanceRent)
	if err != nil {
		return fmt.Errorf("postgres: create contract: %w", contractConflict(err))
	}
	if err := r.writeChildren(ctx, c); err != nil {
		return err
	}
	return r.writeRents(ctx, c.ID, schedule)
}

func (r *contractRepository) Replace(ctx context.Context, c *domain.Contract, version int, schedule []domain.Instalment) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE contracts SET property_id = $2, registry = $3, guarantee_kind = $4, deposit_amount = $5,
			rent = $6, current_rent = $7, admin_fee = $8, late_penalty_rate = $9, late_interest_rate = $10,
			due_day = $11, adjustment_index = $12, signed_on = $13, starts_on = $14, expires_on = $15,
			advance_rent = $18, version = version + 1, updated_at = $16
		  WHERE id = $1 AND version = $17`,
		pgUUID(c.ID), pgUUID(c.PropertyID), c.Registry, string(c.GuaranteeKind), int64(c.DepositAmount),
		int64(c.Rent), int64(c.CurrentRent), int32(c.AdminFee), int32(c.LatePenaltyRate),
		int32(c.LateInterestRate), c.DueDay, string(c.AdjustmentIndex), pgDate(c.SignedOn),
		pgDate(c.StartsOn), pgDate(c.ExpiresOn), c.UpdatedAt, version, c.AdvanceRent)
	if err != nil {
		return fmt.Errorf("postgres: update contract: %w", contractConflict(err))
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: update contract: %w", domain.ErrPreconditionFailed)
	}
	for _, table := range []string{"contract_parties", "contract_acknowledgments", "rents"} {
		if _, err := r.q.Exec(ctx, `DELETE FROM `+table+` WHERE contract_id = $1`, pgUUID(c.ID)); err != nil {
			return fmt.Errorf("postgres: replace %s: %w", table, err)
		}
	}
	if err := r.writeChildren(ctx, c); err != nil {
		return err
	}
	return r.writeRents(ctx, c.ID, schedule)
}

func (r *contractRepository) writeChildren(ctx context.Context, c *domain.Contract) error {
	org, id := pgUUID(r.organizationID), pgUUID(c.ID)
	for i, p := range c.Parties {
		if _, err := r.q.Exec(ctx,
			`INSERT INTO contract_parties (organization_id, contract_id, person_id, role, position)
			 VALUES ($1, $2, $3, $4, $5)`,
			org, id, pgUUID(p.PersonID), string(p.Role), i); err != nil {
			return fmt.Errorf("postgres: write party: %w", contractConflict(err))
		}
	}
	for _, a := range c.Acknowledgements {
		if _, err := r.q.Exec(ctx,
			`INSERT INTO contract_acknowledgments (organization_id, contract_id, code, acknowledged_by, acknowledged_at)
			 VALUES ($1, $2, $3, $4, $5)`,
			org, id, string(a.Code), pgNullUUID(a.AcknowledgedBy), a.AcknowledgedAt); err != nil {
			return fmt.Errorf("postgres: write acknowledgement: %w", err)
		}
	}
	return nil
}

// writeRents inserts the whole schedule in one statement. Not COPY:
// PostgreSQL refuses COPY FROM on a table under row-level security.
func (r *contractRepository) writeRents(ctx context.Context, contractID uuid.UUID, schedule []domain.Instalment) error {
	ids := make([]pgtype.UUID, len(schedule))
	sequences := make([]int32, len(schedule))
	dues := make([]pgtype.Date, len(schedule))
	amounts := make([]int64, len(schedule))
	for i, inst := range schedule {
		ids[i], sequences[i], dues[i], amounts[i] = pgUUID(uuid.NewV7()), int32(inst.Sequence), pgDate(inst.DueOn), int64(inst.Amount)
	}
	_, err := r.q.Exec(ctx,
		`INSERT INTO rents (id, organization_id, contract_id, sequence, due_on, rent_amount)
		 SELECT id, $1, $2, sequence, due_on, rent_amount
		   FROM unnest($3::uuid[], $4::integer[], $5::date[], $6::bigint[]) AS s(id, sequence, due_on, rent_amount)`,
		pgUUID(r.organizationID), pgUUID(contractID), ids, sequences, dues, amounts)
	if err != nil {
		return fmt.Errorf("postgres: write rents: %w", err)
	}
	return nil
}

const contractColumns = `c.id, c.property_id, c.registry, c.guarantee_kind, c.advance_rent, c.deposit_amount, c.rent,
	c.current_rent, c.admin_fee, c.late_penalty_rate, c.late_interest_rate, c.due_day, c.adjustment_index,
	c.signed_on, c.starts_on, c.expires_on, c.terminated_on, c.version, c.created_at, c.updated_at`

func (r *contractRepository) scanContract(row pgx.Row, extra ...any) (*domain.Contract, error) {
	var (
		c                           domain.Contract
		id, property                pgtype.UUID
		guarantee, index            string
		deposit, rent, current      int64
		fee, penalty, interest      int32
		signed, starts, expires, tt pgtype.Date
	)
	dest := append([]any{&id, &property, &c.Registry, &guarantee, &c.AdvanceRent, &deposit, &rent, &current, &fee, &penalty,
		&interest, &c.DueDay, &index, &signed, &starts, &expires, &tt, &c.Version, &c.CreatedAt, &c.UpdatedAt}, extra...)
	if err := row.Scan(dest...); err != nil {
		return nil, noRows(err, "postgres: contract")
	}
	c.ID, c.PropertyID, c.OrganizationID = toUUID(id), toUUID(property), r.organizationID
	c.GuaranteeKind, c.AdjustmentIndex = domain.GuaranteeKind(guarantee), domain.AdjustmentIndex(index)
	c.DepositAmount, c.Rent, c.CurrentRent = domain.Money(deposit), domain.Money(rent), domain.Money(current)
	c.AdminFee, c.LatePenaltyRate, c.LateInterestRate = domain.Rate(fee), domain.Rate(penalty), domain.Rate(interest)
	c.SignedOn, c.StartsOn, c.ExpiresOn, c.TerminatedOn = toDate(signed), toDate(starts), toDate(expires), toNullDate(tt)
	return &c, nil
}

func (r *contractRepository) Get(ctx context.Context, id uuid.UUID) (*domain.Contract, []usecase.ContractPartyView, []usecase.RentRecord, error) {
	c, err := r.scanContract(r.q.QueryRow(ctx, `SELECT `+contractColumns+` FROM contracts c WHERE c.id = $1`, pgUUID(id)))
	if err != nil {
		return nil, nil, nil, err
	}

	rows, err := r.q.Query(ctx,
		`SELECT cp.person_id, cp.role, p.name, p.kind
		   FROM contract_parties cp JOIN people p ON p.id = cp.person_id
		  WHERE cp.contract_id = $1 ORDER BY cp.position`, pgUUID(id))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("postgres: parties: %w", err)
	}
	parties, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (usecase.ContractPartyView, error) {
		var (
			v          usecase.ContractPartyView
			pid        pgtype.UUID
			role, kind string
		)
		err := row.Scan(&pid, &role, &v.Name, &kind)
		v.PersonID, v.Role, v.Kind = toUUID(pid), domain.PartyRole(role), domain.PersonKind(kind)
		return v, err
	})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("postgres: parties: %w", err)
	}
	for _, p := range parties {
		c.Parties = append(c.Parties, domain.ContractParty{PersonID: p.PersonID, Role: p.Role})
	}

	rows, err = r.q.Query(ctx,
		`SELECT code, acknowledged_by, acknowledged_at FROM contract_acknowledgments
		  WHERE contract_id = $1 ORDER BY acknowledged_at, code`, pgUUID(id))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("postgres: acknowledgements: %w", err)
	}
	c.Acknowledgements, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.Acknowledgement, error) {
		var (
			a    domain.Acknowledgement
			code string
			by   pgtype.UUID
		)
		err := row.Scan(&code, &by, &a.AcknowledgedAt)
		a.Code, a.AcknowledgedBy = domain.NoticeCode(code), toNullUUID(by)
		return a, err
	})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("postgres: acknowledgements: %w", err)
	}

	rows, err = r.q.Query(ctx,
		`SELECT r.id, r.sequence, r.due_on, r.rent_amount, r.late_fee, r.amount_paid, r.paid_on,
		        COALESCE((SELECT sum(rc.amount) FROM rent_charges rc WHERE rc.rent_id = r.id), 0)::bigint
		   FROM rents r WHERE r.contract_id = $1 ORDER BY r.sequence`, pgUUID(id))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("postgres: rents: %w", err)
	}
	rents, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (usecase.RentRecord, error) {
		var (
			rr          usecase.RentRecord
			rid         pgtype.UUID
			due, paid   pgtype.Date
			amount, fee int64
			amountPaid  pgtype.Int8
			charges     int64
		)
		err := row.Scan(&rid, &rr.Sequence, &due, &amount, &fee, &amountPaid, &paid, &charges)
		rr.ChargesTotal = domain.Money(charges)
		rr.ID, rr.DueOn, rr.Amount, rr.LateFee, rr.PaidOn = toUUID(rid), toDate(due), domain.Money(amount), domain.Money(fee), toNullDate(paid)
		if amountPaid.Valid {
			m := domain.Money(amountPaid.Int64)
			rr.AmountPaid = &m
		}
		return rr, err
	})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("postgres: rents: %w", err)
	}
	return c, parties, rents, nil
}

func (r *contractRepository) List(ctx context.Context, q usecase.ContractQuery) ([]usecase.ContractSummary, error) {
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
	if q.PropertyID != nil {
		where = append(where, "c.property_id = "+arg(pgUUID(*q.PropertyID)))
	}
	if q.PersonID != nil {
		where = append(where, "EXISTS (SELECT 1 FROM contract_parties cp WHERE cp.contract_id = c.id AND cp.person_id = "+arg(pgUUID(*q.PersonID))+")")
	}
	if q.Status != "" {
		// Only the filters that compare with today add it: PostgreSQL cannot
		// infer the type of a parameter no clause mentions.
		today := func() string { return arg(pgDate(q.Today)) }
		switch q.Status {
		case domain.ContractTerminated:
			where = append(where, "c.terminated_on IS NOT NULL")
		case domain.ContractUpcoming:
			where = append(where, "c.terminated_on IS NULL AND c.starts_on > "+today())
		case domain.ContractExpired:
			where = append(where, "c.terminated_on IS NULL AND c.expires_on < "+today())
		case domain.ContractActive:
			where = append(where, "c.terminated_on IS NULL AND "+today()+" BETWEEN c.starts_on AND c.expires_on")
		}
	}
	if q.After != nil {
		where = append(where, "(c.starts_on, c.id) < ("+arg(pgDate(q.After.StartsOn))+", "+arg(pgUUID(q.After.ID))+")")
	}
	sql := `SELECT ` + contractColumns + `,
	               a.street, a.number, a.complement, a.district, a.city, a.state,
	               ARRAY(SELECT p.name FROM contract_parties cp JOIN people p ON p.id = cp.person_id
	                      WHERE cp.contract_id = c.id AND cp.role = 'tenant' ORDER BY cp.position)
	          FROM contracts c
	          JOIN properties pr ON pr.id = c.property_id
	          JOIN addresses a ON a.id = pr.address_id`
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY c.starts_on DESC, c.id DESC LIMIT " + arg(q.Limit)

	rows, err := r.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("postgres: list contracts: %w", err)
	}
	defer rows.Close()
	var out []usecase.ContractSummary
	for rows.Next() {
		var s usecase.ContractSummary
		c, err := r.scanContract(rows, &s.Address.Street, &s.Address.Number, &s.Address.Complement,
			&s.Address.District, &s.Address.City, &s.Address.State, &s.TenantNames)
		if err != nil {
			return nil, fmt.Errorf("postgres: list contracts: %w", err)
		}
		s.Contract = *c
		out = append(out, s)
	}
	return out, rows.Err()
}

func (r *contractRepository) HasPayments(ctx context.Context, id uuid.UUID) (bool, error) {
	var paid bool
	err := r.q.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM rents WHERE contract_id = $1 AND paid_on IS NOT NULL)`, pgUUID(id)).Scan(&paid)
	if err != nil {
		return false, fmt.Errorf("postgres: contract payments: %w", err)
	}
	return paid, nil
}

func (r *contractRepository) Terminate(ctx context.Context, id uuid.UUID, on domain.Date, version int, at time.Time, plan *domain.TerminationPlan) error {
	tag, err := r.q.Exec(ctx,
		`UPDATE contracts SET terminated_on = $2, version = version + 1, updated_at = $3
		  WHERE id = $1 AND version = $4 AND terminated_on IS NULL`,
		pgUUID(id), pgDate(on), at, version)
	if err != nil {
		return fmt.Errorf("postgres: terminate contract: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: terminate contract: %w", domain.ErrPreconditionFailed)
	}
	if _, err := r.q.Exec(ctx,
		`DELETE FROM rents WHERE contract_id = $1 AND paid_on IS NULL AND sequence > $2`,
		pgUUID(id), plan.LastSequence); err != nil {
		return fmt.Errorf("postgres: remove rents after termination: %w", err)
	}
	if plan.ProratedAmount != nil {
		if _, err := r.q.Exec(ctx,
			`UPDATE rents SET rent_amount = $3 WHERE contract_id = $1 AND sequence = $2 AND paid_on IS NULL`,
			pgUUID(id), plan.LastSequence, int64(*plan.ProratedAmount)); err != nil {
			return fmt.Errorf("postgres: prorate the last rent: %w", err)
		}
	}
	return nil
}

func (r *contractRepository) Delete(ctx context.Context, id uuid.UUID) error {
	tag, err := r.q.Exec(ctx, `DELETE FROM contracts WHERE id = $1`, pgUUID(id))
	return affected(tag, err, "postgres: delete contract")
}
