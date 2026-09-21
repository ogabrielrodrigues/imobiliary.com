package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// writeReceipt writes the ledger lines of a paid rent, in the transaction
// that recorded the payment. The beneficiaries and their shares are decided
// now, as the contract and the property stand, and never again for this rent.
func writeReceipt(ctx context.Context, repos ScopedRepositories, rent *RentView, author *uuid.UUID, at time.Time) error {
	if rent.PaidOn == nil {
		return fmt.Errorf("ledger: rent %s is not paid", rent.ID)
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
	entries, err := domain.ReceiptEntries(&domain.Receipt{
		RentID: rent.ID, ContractID: rent.ContractID, PropertyID: contract.PropertyID, PaidOn: *rent.PaidOn,
		Rent: rent.Amount, LateFee: rent.LateFee, IncomeTax: rent.IncomeTaxWithheld,
		Charges: rent.Charges, AdminFee: contract.AdminFee,
	}, shares)
	if err != nil {
		return err
	}
	for i := range entries {
		entries[i].ID, entries[i].CreatedBy, entries[i].CreatedAt = uuid.NewV7(), author, at
	}
	return repos.Ledger.Insert(ctx, entries)
}

// clearReceipt removes a rent's lines before its payment is reversed or its
// charges change. A line already in a payout refuses, naming the payout, since
// money that left the office cannot be taken back by an edit here.
func clearReceipt(ctx context.Context, repos ScopedRepositories, rentID uuid.UUID, field string) error {
	entries, err := repos.Ledger.RentEntries(ctx, rentID)
	if err != nil {
		return err
	}
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
	return repos.Ledger.DeleteRentEntries(ctx, rentID)
}

// BackfillLedger writes the lines of every rent paid before the ledger
// existed, as if each had just been received, pending. Running it again finds
// nothing to do. It returns how many rents it wrote.
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
			if err := writeReceipt(ctx, repos, rent, nil, u.now().UTC()); err != nil {
				return fmt.Errorf("rent %s: %w", id, err)
			}
			written++
		}
		return nil
	})
	return written, err
}
