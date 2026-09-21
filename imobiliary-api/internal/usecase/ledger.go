package usecase

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// writeReceipt writes the ledger lines of a rent's payments, in the
// transaction that recorded them: every payment, or only the one named. The
// beneficiaries and their shares are decided now, as the contract and the
// property stand, and never again for these lines. The parts of the rent and
// of each charge come from replaying every payment in order, so writing one
// payment's lines alone gives the lines writing them all would.
func writeReceipt(ctx context.Context, repos ScopedRepositories, rent *RentView, only *uuid.UUID, author *uuid.UUID, at time.Time) error {
	if len(rent.Payments) == 0 {
		return fmt.Errorf("ledger: rent %s has no payment", rent.ID)
	}
	contract, _, _, err := repos.Contracts.Get(ctx, rent.ContractID)
	if err != nil {
		return err
	}
	property, _, err := repos.Properties.Get(ctx, contract.PropertyID)
	if err != nil {
		return err
	}
	shares, err := domain.Beneficiaries(domain.Landlords(contract.Parties), property.Owners)
	if errors.Is(err, domain.ErrNoShares) {
		v := &domain.ValidationError{}
		v.Add("parties", "the contract does not say how its landlords share the rent; record their shares first")
		return v
	}
	if err != nil {
		return err
	}
	receipts, err := domain.PaymentReceipts(domain.Receipt{
		RentID: rent.ID, ContractID: rent.ContractID, PropertyID: contract.PropertyID,
		Rent: rent.Amount, Charges: rent.Charges, AdminFee: contract.AdminFee,
	}, rent.Payments)
	if err != nil {
		return err
	}
	var entries []domain.LedgerEntry
	for i := range receipts {
		if only != nil && receipts[i].PaymentID != *only {
			continue
		}
		lines, err := domain.ReceiptEntries(&receipts[i], shares)
		if err != nil {
			return err
		}
		entries = append(entries, lines...)
	}
	for i := range entries {
		entries[i].ID, entries[i].CreatedBy, entries[i].CreatedAt = uuid.NewV7(), author, at
	}
	return repos.Ledger.Insert(ctx, entries)
}

// refuseIfPaidOut answers the refusal for lines already in a payout, naming
// the payout: money that left the office cannot be taken back by an edit here.
func refuseIfPaidOut(ctx context.Context, repos ScopedRepositories, entries []domain.LedgerEntry, field string) error {
	for _, e := range entries {
		if e.PayoutID == nil {
			continue
		}
		v := &domain.ValidationError{}
		if payout, err := repos.Ledger.Payout(ctx, *e.PayoutID); err == nil {
			v.Addf(field, "the rent is in payout %s; undo the payout first", payout.Number())
		} else {
			v.Add(field, "the rent is in a payout; undo the payout first")
		}
		return v
	}
	return nil
}

// clearReceipt removes a rent's lines before its charges change destination,
// or only one payment's lines before it is reversed. A line already in a
// payout refuses.
func clearReceipt(ctx context.Context, repos ScopedRepositories, rentID uuid.UUID, only *uuid.UUID, field string) error {
	entries, err := repos.Ledger.RentEntries(ctx, rentID)
	if err != nil {
		return err
	}
	if only != nil {
		entries = slices.DeleteFunc(entries, func(e domain.LedgerEntry) bool {
			return e.PaymentID == nil || *e.PaymentID != *only
		})
	}
	if err := refuseIfPaidOut(ctx, repos, entries, field); err != nil {
		return err
	}
	if only != nil {
		return repos.Ledger.DeletePaymentEntries(ctx, *only)
	}
	return repos.Ledger.DeleteRentEntries(ctx, rentID)
}

// BackfillLedger writes the lines of every payment received before the
// ledger existed, as if each had just been received, pending. Running it again
// finds nothing to do. It returns how many rents it wrote.
func (u *Rents) BackfillLedger(ctx context.Context, organizationID uuid.UUID) (int, error) {
	written := 0
	err := u.scope.InOrganization(ctx, organizationID, func(repos ScopedRepositories) error {
		ids, err := repos.Rents.PaidWithoutEntries(ctx)
		if err != nil {
			return err
		}
		for _, id := range ids {
			rent, err := repos.Rents.Get(ctx, id)
			if err != nil {
				return err
			}
			entries, err := repos.Ledger.RentEntries(ctx, id)
			if err != nil {
				return err
			}
			for _, p := range rent.Payments {
				if slices.ContainsFunc(entries, func(e domain.LedgerEntry) bool {
					return e.PaymentID != nil && *e.PaymentID == p.ID
				}) {
					continue
				}
				if err := writeReceipt(ctx, repos, rent, &p.ID, nil, u.now().UTC()); err != nil {
					return fmt.Errorf("rent %s: %w", id, err)
				}
			}
			written++
		}
		return nil
	})
	return written, err
}
