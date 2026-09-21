package postgres

import (
	"context"
	"fmt"
	"strings"
	"uuid"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

type ledgerRepository struct {
	q              querier
	organizationID uuid.UUID
}

var _ usecase.LedgerRepository = (*ledgerRepository)(nil)

// The amount is stored with its sign, so a balance is a plain sum; in Go a
// line carries a positive amount and its kind says which way it goes.
func signedAmount(e *domain.LedgerEntry) int64 { return e.Signed() }

func (r *ledgerRepository) Insert(ctx context.Context, entries []domain.LedgerEntry) error {
	if len(entries) == 0 {
		return nil
	}
	var (
		rows []string
		args []any
	)
	for i := range entries {
		e := &entries[i]
		base := len(args)
		ph := make([]string, 14)
		for j := range ph {
			ph[j] = fmt.Sprintf("$%d", base+j+1)
		}
		rows = append(rows, "("+strings.Join(ph, ", ")+")")
		args = append(args, pgUUID(e.ID), pgUUID(r.organizationID), pgUUID(e.PersonID), string(e.Kind),
			signedAmount(e), pgDate(e.OccurredOn), e.Description, pgNullUUID(e.PropertyID), pgNullUUID(e.ContractID),
			pgNullUUID(e.RentID), pgNullUUID(e.ChargeID), pgNullUUID(e.CreatedBy), e.CreatedAt, pgNullUUID(e.PaymentID))
	}
	_, err := r.q.Exec(ctx,
		`INSERT INTO owner_entries (id, organization_id, person_id, kind, amount, occurred_on, description,
		        property_id, contract_id, rent_id, charge_id, created_by, created_at, payment_id)
		 VALUES `+strings.Join(rows, ", "), args...)
	if err != nil {
		if isForeignKeyViolation(err) {
			v := &domain.ValidationError{}
			v.Add("person_id", "names a person or property that does not exist")
			return fmt.Errorf("postgres: write ledger: %w", v)
		}
		return fmt.Errorf("postgres: write ledger: %w", err)
	}
	return nil
}

const entryColumns = `e.id, e.person_id, e.kind, e.amount, e.occurred_on, e.description, e.property_id,
	e.contract_id, e.rent_id, e.charge_id, e.payout_id, e.created_by, e.created_at, e.payment_id`

func scanEntry(row pgx.Row, extra ...any) (domain.LedgerEntry, error) {
	var (
		e                                            domain.LedgerEntry
		id, person, property, contract, rent, charge pgtype.UUID
		payout, author, payment                      pgtype.UUID
		kind                                         string
		amount                                       int64
		on                                           pgtype.Date
	)
	dst := append([]any{&id, &person, &kind, &amount, &on, &e.Description, &property, &contract, &rent, &charge,
		&payout, &author, &e.CreatedAt, &payment}, extra...)
	if err := row.Scan(dst...); err != nil {
		return e, err
	}
	e.ID, e.PersonID, e.Kind, e.OccurredOn = toUUID(id), toUUID(person), domain.EntryKind(kind), toDate(on)
	if amount < 0 {
		amount = -amount
	}
	e.Amount = domain.Money(amount)
	e.PropertyID, e.ContractID, e.RentID = toNullUUID(property), toNullUUID(contract), toNullUUID(rent)
	e.ChargeID, e.PayoutID, e.CreatedBy = toNullUUID(charge), toNullUUID(payout), toNullUUID(author)
	e.PaymentID = toNullUUID(payment)
	return e, nil
}

func (r *ledgerRepository) collect(ctx context.Context, what, sql string, args ...any) ([]domain.LedgerEntry, error) {
	rows, err := r.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("postgres: %s: %w", what, err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (domain.LedgerEntry, error) { return scanEntry(row) })
	if err != nil {
		return nil, fmt.Errorf("postgres: %s: %w", what, err)
	}
	return out, nil
}

func (r *ledgerRepository) RentEntries(ctx context.Context, rentID uuid.UUID) ([]domain.LedgerEntry, error) {
	return r.collect(ctx, "rent lines",
		`SELECT `+entryColumns+` FROM owner_entries e WHERE e.rent_id = $1 ORDER BY e.id FOR UPDATE`, pgUUID(rentID))
}

func (r *ledgerRepository) DeleteRentEntries(ctx context.Context, rentID uuid.UUID) error {
	if _, err := r.q.Exec(ctx, `DELETE FROM owner_entries WHERE rent_id = $1`, pgUUID(rentID)); err != nil {
		return fmt.Errorf("postgres: delete rent lines: %w", paidOut(err))
	}
	return nil
}

func (r *ledgerRepository) DeletePaymentEntries(ctx context.Context, paymentID uuid.UUID) error {
	if _, err := r.q.Exec(ctx, `DELETE FROM owner_entries WHERE payment_id = $1`, pgUUID(paymentID)); err != nil {
		return fmt.Errorf("postgres: delete payment lines: %w", paidOut(err))
	}
	return nil
}

// paidOut turns the trigger that protects a line inside a payout into the
// conflict it is.
func paidOut(err error) error {
	if constraintOf(err) == "owner_entries_paid_out" {
		return domain.ErrConflict
	}
	return err
}

func (r *ledgerRepository) Entry(ctx context.Context, id uuid.UUID) (*domain.LedgerEntry, error) {
	e, err := scanEntry(r.q.QueryRow(ctx, `SELECT `+entryColumns+` FROM owner_entries e WHERE e.id = $1`, pgUUID(id)))
	if err != nil {
		return nil, noRows(err, "postgres: ledger line")
	}
	return &e, nil
}

func (r *ledgerRepository) DeleteEntry(ctx context.Context, id uuid.UUID) error {
	tag, err := r.q.Exec(ctx, `DELETE FROM owner_entries WHERE id = $1`, pgUUID(id))
	return affected(tag, paidOut(err), "postgres: delete ledger line")
}

func (r *ledgerRepository) Entries(ctx context.Context, ids []uuid.UUID) ([]domain.LedgerEntry, error) {
	keys := make([]pgtype.UUID, len(ids))
	for i, id := range ids {
		keys[i] = pgUUID(id)
	}
	return r.collect(ctx, "ledger lines",
		`SELECT `+entryColumns+` FROM owner_entries e WHERE e.id = ANY($1) ORDER BY e.occurred_on, e.id FOR UPDATE`, keys)
}

// entryViewSelect joins what a person reads beside a line: the property's
// address, the contract's number, the rent's sequence and due day, and the
// charge's kind.
const entryViewSelect = `SELECT ` + entryColumns + `,
	       a.street, a.number, a.complement, a.district, a.city, a.state,
	       COALESCE(c.registry, ''), COALESCE(r.sequence, 0), r.due_on,
	       COALESCE(rc.kind, ''), COALESCE(rc.description, '')
	  FROM owner_entries e
	  LEFT JOIN properties pr  ON pr.id = e.property_id
	  LEFT JOIN addresses a    ON a.id = pr.address_id
	  LEFT JOIN contracts c    ON c.id = e.contract_id
	  LEFT JOIN rents r        ON r.id = e.rent_id
	  LEFT JOIN rent_charges rc ON rc.id = e.charge_id`

func (r *ledgerRepository) views(ctx context.Context, what, sql string, args ...any) ([]usecase.EntryView, error) {
	rows, err := r.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("postgres: %s: %w", what, err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (usecase.EntryView, error) {
		var (
			v                                         usecase.EntryView
			street, number, compl, district, city, uf pgtype.Text
			due                                       pgtype.Date
			kind                                      string
		)
		e, err := scanEntry(row, &street, &number, &compl, &district, &city, &uf,
			&v.Registry, &v.RentSequence, &due, &kind, &v.ChargeDescription)
		if err != nil {
			return v, err
		}
		v.LedgerEntry, v.RentDueOn, v.ChargeKind = e, toNullDate(due), domain.ChargeKind(kind)
		if street.Valid {
			v.Address = &domain.Address{Street: street.String, Number: number.String, Complement: compl.String,
				District: district.String, City: city.String, State: uf.String}
		}
		return v, nil
	})
	if err != nil {
		return nil, fmt.Errorf("postgres: %s: %w", what, err)
	}
	return out, nil
}

func (r *ledgerRepository) Pending(ctx context.Context, personID uuid.UUID) ([]usecase.EntryView, error) {
	return r.views(ctx, "pending lines",
		entryViewSelect+` WHERE e.person_id = $1 AND e.payout_id IS NULL ORDER BY e.occurred_on, e.rent_id NULLS LAST, e.id`,
		pgUUID(personID))
}

func (r *ledgerRepository) Balances(ctx context.Context) ([]usecase.Balance, error) {
	rows, err := r.q.Query(ctx,
		`SELECT e.person_id, p.name, p.kind, sum(e.amount)::bigint, count(*), min(e.occurred_on)
		   FROM owner_entries e JOIN people p ON p.id = e.person_id
		  WHERE e.payout_id IS NULL
		  GROUP BY e.person_id, p.name, p.kind
		  ORDER BY min(e.occurred_on), p.name`)
	if err != nil {
		return nil, fmt.Errorf("postgres: balances: %w", err)
	}
	out, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (usecase.Balance, error) {
		var (
			b      usecase.Balance
			id     pgtype.UUID
			kind   string
			oldest pgtype.Date
		)
		err := row.Scan(&id, &b.Name, &kind, &b.Pending, &b.Lines, &oldest)
		b.PersonID, b.Kind, b.OldestOn = toUUID(id), domain.PersonKind(kind), toDate(oldest)
		return b, err
	})
	if err != nil {
		return nil, fmt.Errorf("postgres: balances: %w", err)
	}
	return out, nil
}

func (r *ledgerRepository) CreatePayout(ctx context.Context, p *domain.Payout, entryIDs []uuid.UUID) error {
	// The next number of the office's year, from a counter that never goes
	// back: an undone payout's number stays spent, since its receipt may be
	// printed. The upsert takes the counter's row lock, so two payouts at the
	// same time get consecutive numbers and neither waits on more than that.
	p.Year = p.PaidOn.Year()
	if err := r.q.QueryRow(ctx,
		`INSERT INTO payout_numbers (organization_id, year, last_sequence) VALUES ($1, $2, 1)
		 ON CONFLICT (organization_id, year) DO UPDATE SET last_sequence = payout_numbers.last_sequence + 1
		 RETURNING last_sequence`,
		pgUUID(r.organizationID), p.Year).Scan(&p.Sequence); err != nil {
		return fmt.Errorf("postgres: number payout: %w", err)
	}
	_, err := r.q.Exec(ctx,
		`INSERT INTO payouts (id, organization_id, person_id, year, sequence, paid_on, total, method, note, created_by, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		pgUUID(p.ID), pgUUID(r.organizationID), pgUUID(p.PersonID), p.Year, p.Sequence, pgDate(p.PaidOn),
		int64(p.Total), string(p.Method), p.Note, pgNullUUID(p.CreatedBy), p.CreatedAt)
	if err != nil {
		return fmt.Errorf("postgres: create payout: %w", err)
	}
	keys := make([]pgtype.UUID, len(entryIDs))
	for i, id := range entryIDs {
		keys[i] = pgUUID(id)
	}
	tag, err := r.q.Exec(ctx,
		`UPDATE owner_entries SET payout_id = $1 WHERE id = ANY($2) AND payout_id IS NULL AND person_id = $3`,
		pgUUID(p.ID), keys, pgUUID(p.PersonID))
	if err != nil {
		return fmt.Errorf("postgres: close payout lines: %w", err)
	}
	if int(tag.RowsAffected()) != len(entryIDs) {
		return fmt.Errorf("postgres: close payout lines: %w", domain.ErrConflict)
	}
	return nil
}

const payoutSelect = `SELECT po.id, po.person_id, po.year, po.sequence, po.paid_on, po.total, po.method, po.note,
	       po.created_by, po.created_at, p.name, p.kind
	  FROM payouts po JOIN people p ON p.id = po.person_id`

func scanPayout(row pgx.Row) (*usecase.PayoutSummary, error) {
	var (
		s                  usecase.PayoutSummary
		id, person, author pgtype.UUID
		paid               pgtype.Date
		total              int64
		method, kind       string
	)
	err := row.Scan(&id, &person, &s.Year, &s.Sequence, &paid, &total, &method, &s.Note, &author, &s.CreatedAt,
		&s.PersonName, &kind)
	if err != nil {
		return nil, err
	}
	s.ID, s.PersonID, s.PaidOn, s.Total = toUUID(id), toUUID(person), toDate(paid), domain.Money(total)
	s.Method, s.CreatedBy, s.PersonKind = domain.PayoutMethod(method), toNullUUID(author), domain.PersonKind(kind)
	return &s, nil
}

func (r *ledgerRepository) Payout(ctx context.Context, id uuid.UUID) (*usecase.PayoutSummary, error) {
	s, err := scanPayout(r.q.QueryRow(ctx, payoutSelect+` WHERE po.id = $1`, pgUUID(id)))
	if err != nil {
		return nil, noRows(err, "postgres: payout")
	}
	return s, nil
}

func (r *ledgerRepository) PayoutEntries(ctx context.Context, id uuid.UUID) ([]usecase.EntryView, error) {
	return r.views(ctx, "payout lines",
		entryViewSelect+` WHERE e.payout_id = $1 ORDER BY e.property_id NULLS LAST, e.occurred_on, e.rent_id NULLS LAST, e.id`,
		pgUUID(id))
}

func (r *ledgerRepository) Payouts(ctx context.Context, q usecase.PayoutQuery) ([]usecase.PayoutSummary, error) {
	var (
		where []string
		args  []any
	)
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}
	if q.PersonID != nil {
		where = append(where, "po.person_id = "+arg(pgUUID(*q.PersonID)))
	}
	if q.After != nil {
		where = append(where, "(po.paid_on, po.id) < ("+arg(pgDate(q.After.PaidOn))+", "+arg(pgUUID(q.After.ID))+")")
	}
	sql := payoutSelect
	if len(where) > 0 {
		sql += " WHERE " + strings.Join(where, " AND ")
	}
	sql += " ORDER BY po.paid_on DESC, po.id DESC LIMIT " + arg(q.Limit)
	rows, err := r.q.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("postgres: payouts: %w", err)
	}
	defer rows.Close()
	var out []usecase.PayoutSummary
	for rows.Next() {
		s, err := scanPayout(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: payouts: %w", err)
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

func (r *ledgerRepository) DeletePayout(ctx context.Context, id uuid.UUID) error {
	tag, err := r.q.Exec(ctx, `DELETE FROM payouts WHERE id = $1`, pgUUID(id))
	return affected(tag, err, "postgres: undo payout")
}
