package domain

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
	"uuid"
)

// A contract is a residential or commercial lease of one property, under the
// Lei do Inquilinato (Lei 8.245/1991). It names the parties, the rent and
// its terms, and the guarantee; its instalments are generated from it.

// GuaranteeKind is the lease's one guarantee. Art. 37, sole paragraph, forbids
// more than one in the same contract, which is why it is a single field.
type GuaranteeKind string

const (
	GuaranteeNone            GuaranteeKind = "none"
	GuaranteeDeposit         GuaranteeKind = "deposit"          // caução
	GuaranteeSurety          GuaranteeKind = "surety"           // fiança
	GuaranteeSuretyInsurance GuaranteeKind = "surety_insurance" // seguro fiança
	GuaranteeFundAssignment  GuaranteeKind = "fund_assignment"  // cessão fiduciária de quotas de fundo
)

var guaranteeKinds = []GuaranteeKind{
	GuaranteeNone, GuaranteeDeposit, GuaranteeSurety, GuaranteeSuretyInsurance, GuaranteeFundAssignment,
}

// PartyRole is what a person is to a contract.
type PartyRole string

const (
	RoleLandlord        PartyRole = "landlord"
	RoleTenant          PartyRole = "tenant"
	RoleGuarantor       PartyRole = "guarantor"
	RoleGuarantorSpouse PartyRole = "guarantor_spouse"
)

var partyRoles = []PartyRole{RoleLandlord, RoleTenant, RoleGuarantor, RoleGuarantorSpouse}

// AdjustmentIndex is the price index the rent is adjusted by once a year.
type AdjustmentIndex string

var adjustmentIndexes = []AdjustmentIndex{"igpm", "ipca", "inpc", "ivar", "igpdi"}

// NoticeCode names a legal notice that a contract may only be saved with once
// someone acknowledged it. The user chose this pattern (2026-09-15): the rule
// warns and records the acknowledgement rather than forbidding.
type NoticeCode string

const (
	// NoticeAdvanceRent: the first instalment is due when the lease starts,
	// which is rent paid in advance, while the contract also has a guarantee.
	// Lei 8.245 art. 20 allows advance rent only without a guarantee; art. 43,
	// III makes demanding it otherwise a misdemeanour.
	NoticeAdvanceRent NoticeCode = "advance_rent"
	// NoticeGuarantorSpouseConsent: a married guarantor, outside absolute
	// separation of property, without their spouse among the parties. Civil
	// Code art. 1.647, III requires the spouse's consent; Súmula 332 of the STJ
	// holds the guarantee void without it.
	NoticeGuarantorSpouseConsent NoticeCode = "guarantor_spouse_consent"
	// NoticeDepositLimit: a deposit larger than three months' rent, the cap
	// of art. 38, §2º.
	NoticeDepositLimit NoticeCode = "deposit_limit"
)

var noticeCodes = []NoticeCode{NoticeAdvanceRent, NoticeGuarantorSpouseConsent, NoticeDepositLimit}

// IsNotice reports whether code is a notice this service raises.
func IsNotice(code NoticeCode) bool { return slices.Contains(noticeCodes, code) }

// ContractParty is one person in one role.
type ContractParty struct {
	PersonID uuid.UUID
	Role     PartyRole
}

// Acknowledgement records that someone saw a notice and chose to proceed.
type Acknowledgement struct {
	Code           NoticeCode
	AcknowledgedBy *uuid.UUID
	AcknowledgedAt time.Time
}

// Contract is a lease with its terms.
type Contract struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	PropertyID     uuid.UUID
	// Registry is the office's own number for the contract, unique within it.
	Registry      string
	GuaranteeKind GuaranteeKind
	// DepositAmount exists only with a deposit guarantee.
	DepositAmount Money
	// Rent is the amount agreed at signing; CurrentRent follows the
	// adjustments phase 5 records, and starts equal to it.
	Rent        Money
	CurrentRent Money
	// AdminFee is the office's fee over each rent, 10% unless agreed otherwise.
	AdminFee         Rate
	LatePenaltyRate  Rate // multa, applied once
	LateInterestRate Rate // juros, per month, pro rata by day
	DueDay           int
	AdjustmentIndex  AdjustmentIndex
	SignedOn         Date
	StartsOn         Date
	ExpiresOn        Date
	TerminatedOn     *Date
	Parties          []ContractParty
	Acknowledgements []Acknowledgement
	Version          int
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// Default rates a contract starts with.
const (
	DefaultLatePenalty  Rate = 100_000 // 10%
	DefaultLateInterest Rate = 10_000  // 1% a month
	MaxContractMonths        = 600
	MaxParties               = 20
)

// Instalment is one month of rent in the schedule.
type Instalment struct {
	Sequence int
	DueOn    Date
	Amount   Money
}

// NormalizeContract trims the free text and fills the defaults the plan
// settles: the due day is the signing day's when not given.
func NormalizeContract(c *Contract) {
	c.Registry = collapseSpaces(c.Registry)
	c.AdjustmentIndex = AdjustmentIndex(strings.ToLower(strings.TrimSpace(string(c.AdjustmentIndex))))
	if c.DueDay == 0 && !c.SignedOn.IsZero() {
		c.DueDay = c.SignedOn.Day()
	}
	if c.GuaranteeKind == "" {
		c.GuaranteeKind = GuaranteeNone
	}
}

// ValidateContract checks what a contract can be judged on alone, after
// NormalizeContract. Rules that need the people (a guarantor's marriage) are
// in Notices, with the people passed in.
func ValidateContract(c *Contract) error {
	v := &ValidationError{}

	switch n := utf8.RuneCountInString(c.Registry); {
	case n == 0:
		v.Add("registry", "is required")
	case n > MaxRegistryLength:
		v.Addf("registry", "must be at most %d characters", MaxRegistryLength)
	}
	if c.PropertyID == (uuid.UUID{}) {
		v.Add("property_id", "is required")
	}

	if !slices.Contains(guaranteeKinds, c.GuaranteeKind) {
		v.Add("guarantee_kind", "is not a known guarantee")
	}
	switch {
	case c.GuaranteeKind == GuaranteeDeposit && c.DepositAmount <= 0:
		v.Add("deposit_amount", "is required with a deposit")
	case c.GuaranteeKind != GuaranteeDeposit && c.DepositAmount != 0:
		v.Add("deposit_amount", "belongs to a deposit guarantee")
	}
	if !c.DepositAmount.Valid() {
		v.Add("deposit_amount", "is out of range")
	}

	if c.Rent <= 0 || !c.Rent.Valid() {
		v.Add("rent", "must be greater than zero")
	}
	for field, rate := range map[string]Rate{
		"admin_fee": c.AdminFee, "late_penalty_rate": c.LatePenaltyRate, "late_interest_rate": c.LateInterestRate,
	} {
		if rate < 0 || rate > FullShare {
			v.Add(field, "must be between 0 and 100")
		}
	}
	if c.DueDay < 1 || c.DueDay > 31 {
		v.Add("due_day", "must be between 1 and 31")
	}
	if c.AdjustmentIndex != "" && !slices.Contains(adjustmentIndexes, c.AdjustmentIndex) {
		v.Add("adjustment_index", "is not a known index")
	}

	if c.SignedOn.IsZero() {
		v.Add("signed_on", "is required")
	}
	if c.StartsOn.IsZero() {
		v.Add("starts_on", "is required")
	}
	if c.ExpiresOn.IsZero() {
		v.Add("expires_on", "is required")
	}
	if !c.StartsOn.IsZero() && !c.ExpiresOn.IsZero() {
		switch months := TermMonths(c.StartsOn, c.ExpiresOn); {
		case !c.ExpiresOn.After(c.StartsOn):
			v.Add("expires_on", "must be after the start")
		case months > MaxContractMonths:
			v.Addf("expires_on", "makes a term longer than %d months", MaxContractMonths)
		}
	}

	validateParties(v, c)
	return v.OrNil()
}

func validateParties(v *ValidationError, c *Contract) {
	if len(c.Parties) > MaxParties {
		v.Addf("parties", "must be at most %d", MaxParties)
		return
	}
	roles := map[uuid.UUID][]PartyRole{}
	count := map[PartyRole]int{}
	for i, p := range c.Parties {
		field := fmt.Sprintf("parties[%d]", i)
		if !slices.Contains(partyRoles, p.Role) {
			v.Add(field+".role", "is not a known role")
			continue
		}
		if slices.Contains(roles[p.PersonID], p.Role) {
			v.Add(field+".person_id", "appears twice in the same role")
		}
		roles[p.PersonID] = append(roles[p.PersonID], p.Role)
		count[p.Role]++
	}

	if count[RoleLandlord] == 0 {
		v.Add("parties", "must name at least one landlord")
	}
	if count[RoleTenant] == 0 {
		v.Add("parties", "must name at least one tenant")
	}
	surety := c.GuaranteeKind == GuaranteeSurety
	switch {
	case surety && count[RoleGuarantor] == 0:
		v.Add("parties", "must name a guarantor with a surety guarantee")
	case !surety && count[RoleGuarantor]+count[RoleGuarantorSpouse] > 0:
		v.Add("parties", "may have guarantors only with a surety guarantee")
	}
	for _, held := range roles {
		tenant := slices.Contains(held, RoleTenant)
		switch {
		case tenant && (slices.Contains(held, RoleGuarantor) || slices.Contains(held, RoleGuarantorSpouse)):
			v.Add("parties", "a tenant cannot guarantee their own lease")
		case tenant && slices.Contains(held, RoleLandlord):
			v.Add("parties", "a person cannot be landlord and tenant of the same lease")
		}
	}
}

// TermMonths is the number of monthly instalments between two dates: whole
// months, and one more for any remainder. A lease from 1 October to 30
// September three years later is 36 months, and so is one to 1 October.
func TermMonths(starts, expires Date) int {
	months := (expires.Year()-starts.Year())*12 + int(expires.Month()) - int(starts.Month())
	for months > 0 && starts.AddMonths(months).After(expires) {
		months--
	}
	if starts.AddMonths(months).Before(expires) {
		months++
	}
	return max(months, 1)
}

// Schedule is every instalment of a contract, as the plan settles it: one per
// month of term, the first due on the start date, instalment k after it due on
// the due day of the k-1th month after the start, a day the month lacks
// falling on its last day. Every instalment is a whole month's rent; there is
// no pro rata.
func Schedule(c *Contract) []Instalment {
	n := TermMonths(c.StartsOn, c.ExpiresOn)
	out := make([]Instalment, 0, n)
	for k := 1; k <= n; k++ {
		due := c.StartsOn
		if k > 1 {
			month := c.StartsOn.AddMonths(k - 1)
			due = DateInMonth(month.Year(), month.Month(), c.DueDay)
		}
		out = append(out, Instalment{Sequence: k, DueOn: due, Amount: c.CurrentRent})
	}
	return out
}

// PartyPerson is what the notices need to know of a party.
type PartyPerson struct {
	MaritalStatus  MaritalStatus
	PropertyRegime PropertyRegime
	SpouseID       *uuid.UUID
}

// Notices lists the legal notices a contract raises, in a stable order.
func Notices(c *Contract, people map[uuid.UUID]PartyPerson) []NoticeCode {
	var out []NoticeCode
	if c.GuaranteeKind != GuaranteeNone {
		// The first instalment is always due at the start.
		out = append(out, NoticeAdvanceRent)
	}
	if c.GuaranteeKind == GuaranteeSurety {
		spouses := map[uuid.UUID]bool{}
		for _, p := range c.Parties {
			if p.Role == RoleGuarantorSpouse {
				spouses[p.PersonID] = true
			}
		}
		for _, p := range c.Parties {
			if p.Role != RoleGuarantor {
				continue
			}
			person := people[p.PersonID]
			// The consent binds a marriage; outside absolute (agreed) separation
			// of property it is needed. A stable union is not covered by art.
			// 1.647 as the STJ reads it.
			if person.MaritalStatus != MaritalMarried || person.PropertyRegime == RegimeTotalSeparation {
				continue
			}
			if person.SpouseID == nil || !spouses[*person.SpouseID] {
				out = append(out, NoticeGuarantorSpouseConsent)
				break
			}
		}
	}
	if c.GuaranteeKind == GuaranteeDeposit && c.Rent > 0 && int64(c.DepositAmount) > 3*int64(c.Rent) {
		out = append(out, NoticeDepositLimit)
	}
	return out
}

// MissingAcknowledgements reports the notices raised and not acknowledged, as
// a validation error on "acknowledgments", one entry per notice.
func MissingAcknowledgements(raised, acknowledged []NoticeCode) error {
	v := &ValidationError{}
	for _, code := range raised {
		if !slices.Contains(acknowledged, code) {
			v.Add("acknowledgments", string(code))
		}
	}
	return v.OrNil()
}

// ContractStatus is where a contract stands on a given day. It is computed,
// never stored.
type ContractStatus string

const (
	ContractUpcoming   ContractStatus = "upcoming"
	ContractActive     ContractStatus = "active"
	ContractExpired    ContractStatus = "expired"
	ContractTerminated ContractStatus = "terminated"
)

// StatusOn says where a contract stands on a day.
func (c *Contract) StatusOn(today Date) ContractStatus {
	switch {
	case c.TerminatedOn != nil:
		return ContractTerminated
	case today.Before(c.StartsOn):
		return ContractUpcoming
	case today.After(c.ExpiresOn):
		return ContractExpired
	default:
		return ContractActive
	}
}

// ValidateTermination checks a termination date against the contract.
func ValidateTermination(c *Contract, on Date) error {
	v := &ValidationError{}
	switch {
	case c.TerminatedOn != nil:
		v.Add("terminated_on", "the contract is already terminated")
	case on.IsZero():
		v.Add("terminated_on", "is required")
	case on.Before(c.StartsOn):
		v.Add("terminated_on", "must not be before the start")
	case on.After(c.ExpiresOn):
		v.Add("terminated_on", "must not be after the expiry")
	}
	return v.OrNil()
}
