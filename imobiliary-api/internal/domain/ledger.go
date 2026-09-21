package domain

import (
	"fmt"
	"math/bits"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
	"uuid"
)

// The owner's ledger (PLANO-REPASSE.md §2). Everything the office owes a
// beneficiary, or deducts from them, is a line; the lines without a payout are
// the balance to pay out; a payout closes a set of lines on the day the office
// transferred. Lines are never edited: a correction is another line, or undoing
// what created them while nothing was paid out.

// EntryKind is what a ledger line records.
type EntryKind string

const (
	EntryRent      EntryKind = "rent"       // the beneficiary's part of a rent
	EntryLateFee   EntryKind = "late_fee"   // of the late penalty and interest, all the owner's
	EntryCharge    EntryKind = "charge"     // of a charge whose destination is the owner
	EntryAdminFee  EntryKind = "admin_fee"  // the office's fee, deducted
	EntryIncomeTax EntryKind = "income_tax" // withheld by a company tenant, deducted
	EntryDebit     EntryKind = "debit"      // typed by the office: an expense it paid
	EntryCredit    EntryKind = "credit"     // typed by the office: anything owed
)

var entryKinds = []EntryKind{EntryRent, EntryLateFee, EntryCharge, EntryAdminFee, EntryIncomeTax, EntryDebit, EntryCredit}

// IsCredit reports whether a line of this kind adds to what the office owes.
func (k EntryKind) IsCredit() bool {
	return k == EntryRent || k == EntryLateFee || k == EntryCharge || k == EntryCredit
}

// IsManual reports whether the office types lines of this kind.
func (k EntryKind) IsManual() bool { return k == EntryDebit || k == EntryCredit }

// LedgerEntry is one line. Amount is always positive; the kind gives the sign.
type LedgerEntry struct {
	ID          uuid.UUID
	PersonID    uuid.UUID
	Kind        EntryKind
	Amount      Money
	OccurredOn  Date
	Description string
	PropertyID  *uuid.UUID
	ContractID  *uuid.UUID
	RentID      *uuid.UUID
	// PaymentID is the rent payment the line came from.
	PaymentID *uuid.UUID
	ChargeID  *uuid.UUID
	PayoutID  *uuid.UUID
	CreatedBy *uuid.UUID
	CreatedAt time.Time
}

// Signed is the line's effect on the balance: positive for a credit.
func (e *LedgerEntry) Signed() int64 {
	if e.Kind.IsCredit() {
		return int64(e.Amount)
	}
	return -int64(e.Amount)
}

// Beneficiary is who receives a part of a rent, and how large a part.
type Beneficiary struct {
	PersonID uuid.UUID
	Share    Rate
}

// ErrNoShares reports landlords whose parts cannot be told: they are not the
// property's owners and the contract records no share for them.
var ErrNoShares = fmt.Errorf("the landlords' shares are not known")

// Beneficiaries decides who receives a rent. The landlords are the
// beneficiaries; when they are exactly the property's owners, the property's
// shares decide, as they stand on the day, and otherwise the contract's.
// The result keeps the landlords' order, so the last one is always the same.
func Beneficiaries(landlords []ContractParty, owners []PropertyOwner) ([]Beneficiary, error) {
	if len(landlords) == 0 {
		return nil, ErrNoShares
	}
	if SameLandlordsAsOwners(landlords, owners) {
		share := map[uuid.UUID]Rate{}
		for _, o := range owners {
			share[o.PersonID] = o.Share
		}
		out := make([]Beneficiary, 0, len(landlords))
		for _, l := range landlords {
			out = append(out, Beneficiary{PersonID: l.PersonID, Share: share[l.PersonID]})
		}
		return out, nil
	}
	out := make([]Beneficiary, 0, len(landlords))
	var total int64
	for _, l := range landlords {
		if l.Share == nil {
			return nil, ErrNoShares
		}
		out = append(out, Beneficiary{PersonID: l.PersonID, Share: *l.Share})
		total += int64(*l.Share)
	}
	if total != int64(FullShare) {
		return nil, ErrNoShares
	}
	return out, nil
}

// SameLandlordsAsOwners reports whether the landlords are exactly the
// property's owners, as a set.
func SameLandlordsAsOwners(landlords []ContractParty, owners []PropertyOwner) bool {
	if len(landlords) != len(owners) {
		return false
	}
	ids := make([]uuid.UUID, 0, len(owners))
	for _, o := range owners {
		ids = append(ids, o.PersonID)
	}
	for _, l := range landlords {
		if !slices.Contains(ids, l.PersonID) {
			return false
		}
	}
	return true
}

// Landlords is the landlord parties of a contract, in its order.
func Landlords(parties []ContractParty) []ContractParty {
	var out []ContractParty
	for _, p := range parties {
		if p.Role == RoleLandlord {
			out = append(out, p)
		}
	}
	return out
}

// NormalizeLandlordShares drops shares that do not apply: any on a party who
// is not a landlord, and all of them when the landlords are exactly the
// property's owners, whose own shares decide.
func NormalizeLandlordShares(parties []ContractParty, owners []PropertyOwner) {
	same := SameLandlordsAsOwners(Landlords(parties), owners)
	for i := range parties {
		if same || parties[i].Role != RoleLandlord {
			parties[i].Share = nil
		}
	}
}

// ValidateLandlordShares checks the shares a contract carries on its
// landlords, after NormalizeLandlordShares: none needed when the landlords are
// the property's owners; otherwise every landlord's, adding up to 100%.
func ValidateLandlordShares(v *ValidationError, parties []ContractParty, owners []PropertyOwner) {
	if SameLandlordsAsOwners(Landlords(parties), owners) {
		return
	}
	var total int64
	for i, p := range parties {
		if p.Role != RoleLandlord {
			continue
		}
		field := fmt.Sprintf("parties[%d].share", i)
		switch {
		case p.Share == nil:
			v.Add(field, "is required when the landlords are not the property's owners")
			return
		case *p.Share <= 0 || *p.Share > FullShare:
			v.Add(field, "must be greater than 0 and at most 100")
			return
		}
		total += int64(*p.Share)
	}
	if total != int64(FullShare) {
		v.Add("parties", "the landlords' shares must add up to 100")
	}
}

// Split divides an amount by shares that add up to 100%. Every part but the
// last is the amount times its share, rounded down; the last takes what is
// left. So the parts always add up to the amount exactly, none is negative,
// and the last beneficiary gains at most a centavo per other beneficiary.
func Split(amount Money, shares []Beneficiary) ([]Money, error) {
	if len(shares) == 0 || amount < 0 {
		return nil, ErrNoShares
	}
	out := make([]Money, len(shares))
	rest := int64(amount)
	for i, b := range shares[:len(shares)-1] {
		if b.Share < 0 {
			return nil, ErrNoShares
		}
		// The full 128-bit product: an amount near MaxMoney times a share
		// would overflow 64 bits.
		hi, lo := bits.Mul64(uint64(amount), uint64(b.Share))
		part, _ := bits.Div64(hi, lo, RateScale)
		out[i] = Money(part)
		rest -= int64(part)
	}
	if rest < 0 {
		return nil, ErrNoShares
	}
	out[len(out)-1] = Money(rest)
	return out, nil
}

// Receipt is one payment of a rent as it was received: what the ledger is fed
// from. Rent and each charge's Amount are the parts this payment settled.
type Receipt struct {
	RentID     uuid.UUID
	PaymentID  uuid.UUID
	ContractID uuid.UUID
	PropertyID uuid.UUID
	PaidOn     Date
	Rent       Money
	LateFee    Money
	IncomeTax  Money
	Charges    []Charge
	AdminFee   Rate
}

// AdminFeeBase is what the administration fee is charged on: the rent and the
// charges that go to the owner. The late fee never pays it, and neither does a
// charge the office only pays on (user's rules, 2026-09-16 and 2026-09-21).
func (r *Receipt) AdminFeeBase() (Money, error) {
	base := r.Rent
	for _, c := range r.Charges {
		if c.Destination != DestinationOwner {
			continue
		}
		var err error
		if base, err = base.Add(c.Amount); err != nil {
			return 0, err
		}
	}
	return base, nil
}

// AdminFeeAmount is the office's fee on the receipt.
func (r *Receipt) AdminFeeAmount() (Money, error) {
	base, err := r.AdminFeeBase()
	if err != nil {
		return 0, err
	}
	return base.Portion(r.AdminFee)
}

// ReceiptEntries are the lines a received rent writes: for each beneficiary,
// their part of the rent, of the late fee, of each charge that is the owner's,
// less their part of the office's fee and of the tax withheld. Each amount is
// split on its own, so every total adds up exactly. A part of zero writes no
// line. IDs, creation time and author are the caller's to fill.
func ReceiptEntries(r *Receipt, shares []Beneficiary) ([]LedgerEntry, error) {
	fee, err := r.AdminFeeAmount()
	if err != nil {
		return nil, err
	}
	type component struct {
		kind   EntryKind
		amount Money
		charge *Charge
	}
	components := []component{{kind: EntryRent, amount: r.Rent}, {kind: EntryLateFee, amount: r.LateFee}}
	for i := range r.Charges {
		if r.Charges[i].Destination == DestinationOwner {
			components = append(components, component{kind: EntryCharge, amount: r.Charges[i].Amount, charge: &r.Charges[i]})
		}
	}
	components = append(components,
		component{kind: EntryAdminFee, amount: fee},
		component{kind: EntryIncomeTax, amount: r.IncomeTax})

	rentID, paymentID, contractID, propertyID := r.RentID, r.PaymentID, r.ContractID, r.PropertyID
	var out []LedgerEntry
	for _, c := range components {
		parts, err := Split(c.amount, shares)
		if err != nil {
			return nil, err
		}
		for i, part := range parts {
			if part == 0 {
				continue
			}
			e := LedgerEntry{
				PersonID: shares[i].PersonID, Kind: c.kind, Amount: part, OccurredOn: r.PaidOn,
				RentID: &rentID, PaymentID: &paymentID, ContractID: &contractID, PropertyID: &propertyID,
			}
			if c.charge != nil {
				chargeID := c.charge.ID
				e.ChargeID = &chargeID
			}
			out = append(out, e)
		}
	}
	return out, nil
}

// MaxEntryDescriptionLength bounds what a manual line says.
const MaxEntryDescriptionLength = 120

// NormalizeEntry trims the description.
func NormalizeEntry(e *LedgerEntry) {
	e.Description = strings.TrimSpace(e.Description)
}

// ValidateManualEntry checks a debit or credit the office types: a positive
// amount, a description saying what it is, and a day not in the future.
func ValidateManualEntry(e *LedgerEntry, today Date) error {
	v := &ValidationError{}
	if !e.Kind.IsManual() {
		v.Add("kind", "must be debit or credit")
	}
	if e.Amount <= 0 || !e.Amount.Valid() {
		v.Add("amount", "must be greater than zero")
	}
	switch n := utf8.RuneCountInString(e.Description); {
	case n == 0:
		v.Add("description", "is required")
	case n > MaxEntryDescriptionLength:
		v.Addf("description", "must be at most %d characters", MaxEntryDescriptionLength)
	}
	switch {
	case e.OccurredOn.IsZero():
		v.Add("occurred_on", "is required")
	case e.OccurredOn.After(today):
		v.Add("occurred_on", "must not be in the future")
	}
	return v.OrNil()
}

// PayoutMethod is how the office transferred. Informative only: the platform
// moves no money.
type PayoutMethod string

const (
	PayoutUnspecified PayoutMethod = ""
	PayoutPix         PayoutMethod = "pix"
	PayoutTransfer    PayoutMethod = "transfer"
	PayoutCash        PayoutMethod = "cash"
	PayoutCheck       PayoutMethod = "check"
	PayoutOther       PayoutMethod = "other"
)

var payoutMethods = []PayoutMethod{PayoutUnspecified, PayoutPix, PayoutTransfer, PayoutCash, PayoutCheck, PayoutOther}

// MaxPayoutNoteLength bounds the note on a payout.
const MaxPayoutNoteLength = 280

// Payout is a set of one beneficiary's lines, closed on the day the office
// transferred their total.
type Payout struct {
	ID        uuid.UUID
	PersonID  uuid.UUID
	Year      int
	Sequence  int
	PaidOn    Date
	Total     Money
	Method    PayoutMethod
	Note      string
	CreatedBy *uuid.UUID
	CreatedAt time.Time
}

// Number is how a receipt names the payout: 2026/0001.
func (p *Payout) Number() string { return fmt.Sprintf("%d/%04d", p.Year, p.Sequence) }

// NormalizePayout trims the note.
func NormalizePayout(p *Payout) {
	p.Note = strings.TrimSpace(p.Note)
}

// PayoutTotal is what a set of lines adds up to.
func PayoutTotal(entries []LedgerEntry) int64 {
	var total int64
	for i := range entries {
		total += entries[i].Signed()
	}
	return total
}

// ValidatePayout checks a payout over the lines it closes: all of them the
// beneficiary's and still pending, at least one, and a total above zero. A
// balance that is negative waits for the next rent.
func ValidatePayout(p *Payout, entries []LedgerEntry, today Date) error {
	v := &ValidationError{}
	switch {
	case p.PaidOn.IsZero():
		v.Add("paid_on", "is required")
	case p.PaidOn.After(today):
		v.Add("paid_on", "must not be in the future")
	}
	if !slices.Contains(payoutMethods, p.Method) {
		v.Add("method", "is not a known method")
	}
	if utf8.RuneCountInString(p.Note) > MaxPayoutNoteLength {
		v.Addf("note", "must be at most %d characters", MaxPayoutNoteLength)
	}
	if len(entries) == 0 {
		v.Add("entry_ids", "must name at least one line")
		return v.OrNil()
	}
	for _, e := range entries {
		switch {
		case e.PersonID != p.PersonID:
			v.Add("entry_ids", "must all be lines of the payout's beneficiary")
			return v.OrNil()
		case e.PayoutID != nil:
			v.Add("entry_ids", "must all be pending")
			return v.OrNil()
		case !p.PaidOn.IsZero() && e.OccurredOn.After(p.PaidOn):
			v.Add("entry_ids", "must not be later than the payout")
			return v.OrNil()
		}
	}
	total := PayoutTotal(entries)
	switch {
	case total <= 0:
		v.Add("entry_ids", "must add up to more than zero")
	case !Money(total).Valid():
		v.Add("entry_ids", "add up to more than an amount can hold")
	}
	return v.OrNil()
}

// IsKnownEntryKind reports whether k is a kind the ledger records.
func IsKnownEntryKind(k EntryKind) bool { return slices.Contains(entryKinds, k) }
