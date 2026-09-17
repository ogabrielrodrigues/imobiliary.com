// Package usecase holds the application's operations and the interfaces they
// depend on.
//
// Those interfaces are declared here, in the consumer, rather than next to the
// implementations that satisfy them. That is the Go idiom, and it is what
// gives the dependency inversion this design relies on: the adapters in
// internal/adapter know nothing about this package, yet plug into it. Keeping
// each interface to the handful of methods one use case calls is interface
// segregation in practice, and it makes the test fakes small enough to write
// by hand.
package usecase

import (
	"context"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// Clock is the service's source of time, replaced in tests.
type Clock func() time.Time

// OrganizationRepository stores offices.
type OrganizationRepository interface {
	Create(ctx context.Context, o *domain.Organization) error
	ByID(ctx context.Context, id uuid.UUID) (*domain.Organization, error)
	Rename(ctx context.Context, id uuid.UUID, name string, at time.Time) error
	// Delete removes an office and, through the cascades, its memberships,
	// invitations and sessions. Only an account closing as the office's sole
	// member reaches it. An office that still holds business data is
	// domain.ErrInUse: that data is never deleted as a side effect.
	Delete(ctx context.Context, id uuid.UUID) error
}

// UserRepository stores accounts.
type UserRepository interface {
	Create(ctx context.Context, u *domain.User) error
	ByEmail(ctx context.Context, email string) (*domain.User, error)
	ByID(ctx context.Context, id uuid.UUID) (*domain.User, error)
	// UpdatePassword replaces the stored hash and records when it changed,
	// which is what invalidates every access token minted before it.
	UpdatePassword(ctx context.Context, id uuid.UUID, hash string, at time.Time) error
	SetTOTPConfirmed(ctx context.Context, id uuid.UUID, at *time.Time) error
	Delete(ctx context.Context, id uuid.UUID) error
}

// MembershipRepository ties accounts to organisations.
type MembershipRepository interface {
	Create(ctx context.Context, m *domain.Membership) error
	// Get reports domain.ErrNotFound when the account does not belong to the
	// organisation, which is the check every authenticated request makes.
	Get(ctx context.Context, organizationID, userID uuid.UUID) (*domain.Membership, error)
	ForUser(ctx context.Context, userID uuid.UUID) ([]MembershipWithOrganization, error)
	Members(ctx context.Context, organizationID uuid.UUID) ([]Member, error)
	UpdateRole(ctx context.Context, organizationID, userID uuid.UUID, role domain.Role, at time.Time) error
	Delete(ctx context.Context, organizationID, userID uuid.UUID) error
	// CountAdmins backs the rule that an organisation is never left without
	// one. It is called inside the transaction that would remove the last.
	CountAdmins(ctx context.Context, organizationID uuid.UUID) (int, error)
	// CountMembers tells an office with other people in it from one that is
	// only its administrator.
	CountMembers(ctx context.Context, organizationID uuid.UUID) (int, error)
}

// MembershipWithOrganization is a membership with the office it names, which
// is what a sign-in has to show when someone belongs to more than one.
type MembershipWithOrganization struct {
	Organization *domain.Organization
	Role         domain.Role
	// JoinedAt is when the membership was created.
	JoinedAt time.Time
}

// Member is a row of the members list.
type Member struct {
	User *domain.User
	Role domain.Role
	// JoinedAt is when the membership was created, not the account.
	JoinedAt time.Time
}

// SessionRepository stores refresh tokens and the links between them.
type SessionRepository interface {
	Create(ctx context.Context, t *domain.RefreshToken) error
	ByHash(ctx context.Context, hash []byte) (*domain.RefreshToken, error)
	// Rotate marks the old token used and stores its successor in one
	// statement, so two requests racing the same secret cannot both succeed.
	// The loser is reported as domain.ErrSessionReused.
	Rotate(ctx context.Context, previousID uuid.UUID, at time.Time, next *domain.RefreshToken) error
	Revoke(ctx context.Context, id uuid.UUID, at time.Time) error
	RevokeAllForUser(ctx context.Context, userID uuid.UUID, at time.Time) error
	// ForUser lists every refresh token still stored for an account, for the
	// export. Oldest first.
	ForUser(ctx context.Context, userID uuid.UUID) ([]*domain.RefreshToken, error)
	DeleteExpired(ctx context.Context, before time.Time) (int64, error)
}

// PasswordResetRepository stores the one-time tokens that authorise setting a
// password without knowing the old one.
type PasswordResetRepository interface {
	Create(ctx context.Context, r *domain.PasswordReset) error
	ByHash(ctx context.Context, hash []byte) (*domain.PasswordReset, error)
	// Consume marks a token used, reporting domain.ErrNotFound when it was
	// already spent: the check and the write are one statement, so two
	// requests racing the same token cannot both succeed.
	Consume(ctx context.Context, id uuid.UUID, at time.Time) error
	InvalidateForUser(ctx context.Context, userID uuid.UUID, at time.Time) error
	DeleteExpired(ctx context.Context, before time.Time) (int64, error)
}

// InvitationRepository stores the links that let someone join an office.
type InvitationRepository interface {
	Create(ctx context.Context, i *domain.Invitation) error
	ByHash(ctx context.Context, hash []byte) (*domain.Invitation, error)
	ByID(ctx context.Context, organizationID, id uuid.UUID) (*domain.Invitation, error)
	ForOrganization(ctx context.Context, organizationID uuid.UUID) ([]*domain.Invitation, error)
	// ForEmail lists the invitations addressed to an address, with the office
	// that sent each, for the export.
	ForEmail(ctx context.Context, email string) ([]ReceivedInvitation, error)
	Accept(ctx context.Context, id uuid.UUID, at time.Time) error
	Revoke(ctx context.Context, id uuid.UUID, at time.Time) error
}

// ReceivedInvitation is an invitation seen from the side of the person invited.
type ReceivedInvitation struct {
	Invitation       *domain.Invitation
	OrganizationName string
}

// MFARepository stores the second factor and its recovery codes.
type MFARepository interface {
	SaveEnrollment(ctx context.Context, e *domain.TOTPEnrollment) error
	Enrollment(ctx context.Context, userID uuid.UUID) (*domain.TOTPEnrollment, error)
	Confirm(ctx context.Context, userID uuid.UUID, at time.Time, step int64) error
	// RecordStep stores the step of an accepted code, which is what stops the
	// same code being accepted twice.
	RecordStep(ctx context.Context, userID uuid.UUID, step int64) error
	DeleteEnrollment(ctx context.Context, userID uuid.UUID) error
	ReplaceRecoveryCodes(ctx context.Context, userID uuid.UUID, hashes [][]byte) error
	// ConsumeRecoveryCode spends a code, reporting domain.ErrNotFound when no
	// unused code matches.
	ConsumeRecoveryCode(ctx context.Context, userID uuid.UUID, hash []byte, at time.Time) error
	CountUnusedRecoveryCodes(ctx context.Context, userID uuid.UUID) (int, error)
	CreateChallenge(ctx context.Context, c *domain.MFAChallenge) error
	ChallengeByHash(ctx context.Context, hash []byte) (*domain.MFAChallenge, error)
	ConsumeChallenge(ctx context.Context, id uuid.UUID, at time.Time) error
}

// AuditRepository appends to the two records the service keeps.
//
// There is no method to change or remove one: the migration revokes UPDATE and
// DELETE on the trail from the application role, and this interface says the
// same thing in Go.
type AuditRepository interface {
	Record(ctx context.Context, e *domain.AuditEvent) error
	RecordAccess(ctx context.Context, r *domain.AccessRecord) error
	// PurgeAccessRecords removes the records older than the Marco Civil's six
	// months, and reports how many went.
	PurgeAccessRecords(ctx context.Context, before time.Time) (int64, error)
	// EventsByActor and AccessRecordsForUser read back what concerns one
	// account, for the export. Oldest first.
	EventsByActor(ctx context.Context, userID uuid.UUID) ([]*domain.AuditEvent, error)
	AccessRecordsForUser(ctx context.Context, userID uuid.UUID) ([]*domain.AccessRecord, error)
	// RecordClosedAccount keeps the sealed address of a deleted account, so its
	// access records still name someone for as long as they are kept.
	RecordClosedAccount(ctx context.Context, userID uuid.UUID, sealedEmail []byte, at time.Time) error
	PurgeClosedAccounts(ctx context.Context, before time.Time) (int64, error)
}

// Repositories is every store one use case may need, gathered so that a
// transaction can hand over a complete set bound to itself.
type Repositories struct {
	Organizations OrganizationRepository
	Users         UserRepository
	Memberships   MembershipRepository
	Sessions      SessionRepository
	Resets        PasswordResetRepository
	Invitations   InvitationRepository
	MFA           MFARepository
	Audit         AuditRepository
}

// StoredPerson is a person as the repository keeps it: the fields in the
// clear, and the sealed ones as ciphertext with their blind indexes. The use
// case seals on the way in and opens on the way out; the repository never sees
// a CPF.
type StoredPerson struct {
	// Person carries every field except email, phone, CPF, CNPJ and the birth
	// date, which travel sealed below.
	Person    domain.Person
	Email     []byte
	Phone     []byte
	CPF       []byte
	CPFIndex  []byte
	CNPJ      []byte
	CNPJIndex []byte
	BirthDate []byte
}

// PersonQuery filters and pages the list of people.
type PersonQuery struct {
	// NameContains matches a fragment of the folded name.
	NameContains string
	// CPFIndex or CNPJIndex, when set, look one document up exactly.
	CPFIndex  []byte
	CNPJIndex []byte
	Kind      domain.PersonKind
	After     *PersonCursor
	Limit     int
}

// PersonCursor is where a page of the alphabetical list ended.
type PersonCursor struct {
	// SortKey is the folded name, as the database orders it.
	SortKey string
	ID      uuid.UUID
}

// PersonLink is what the rules about spouses, representatives and a
// contract's notices need to know of another person.
type PersonLink struct {
	ID             uuid.UUID
	Kind           domain.PersonKind
	Name           string
	MaritalStatus  domain.MaritalStatus
	PropertyRegime domain.PropertyRegime
	SpouseID       *uuid.UUID
}

// PersonRepository stores people. It is only ever bound to an
// organisation-scoped transaction, so row-level security applies to every
// statement it runs.
type PersonRepository interface {
	// Create reports a CPF or CNPJ already registered in the office as a
	// validation error on that field.
	Create(ctx context.Context, p *StoredPerson) error
	// Update replaces the person when its version still matches, reporting
	// domain.ErrPreconditionFailed otherwise, and increments it.
	Update(ctx context.Context, p *StoredPerson, version int) error
	Get(ctx context.Context, id uuid.UUID) (*StoredPerson, error)
	List(ctx context.Context, q PersonQuery) ([]domain.PersonSummary, []PersonCursor, error)
	// Links reads the named people, for the spouse and representative rules.
	// Missing ids are simply absent from the map.
	Links(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]PersonLink, error)
	// SetSpouse writes one side of a marriage link and bumps that person's
	// version, since their record changed.
	SetSpouse(ctx context.Context, personID uuid.UUID, spouseID *uuid.UUID, at time.Time) error
	// Delete reports domain.ErrInUse when something still links to the person.
	Delete(ctx context.Context, id uuid.UUID) error
}

// PropertyQuery filters and pages the list of properties.
type PropertyQuery struct {
	// AddressContains matches a fragment of the folded street, district or
	// city, or of the registry or municipal registration.
	AddressContains string
	// OwnerID keeps only the properties that person owns a share of.
	OwnerID *uuid.UUID
	After   *PropertyCursor
	Limit   int
}

// PropertyCursor is where a page of the list, ordered by address, ended.
type PropertyCursor struct {
	SortKey string
	ID      uuid.UUID
}

// PropertyOwnerView is an owner as a screen shows them: the share, and who
// the person is.
type PropertyOwnerView struct {
	PersonID uuid.UUID
	Share    domain.Rate
	Name     string
	Kind     domain.PersonKind
}

// PropertyRepository stores properties, bound to an organisation-scoped
// transaction like PersonRepository.
type PropertyRepository interface {
	Create(ctx context.Context, p *domain.Property) error
	// Update replaces the property when its version still matches, reporting
	// domain.ErrPreconditionFailed otherwise.
	Update(ctx context.Context, p *domain.Property, version int) error
	Get(ctx context.Context, id uuid.UUID) (*domain.Property, []PropertyOwnerView, error)
	List(ctx context.Context, q PropertyQuery) ([]domain.PropertySummary, []PropertyCursor, error)
	// Delete removes the property, its owners and its address, reporting
	// domain.ErrInUse when something still links to it.
	Delete(ctx context.Context, id uuid.UUID) error
}

// ContractQuery filters and pages the list of contracts, newest start first.
type ContractQuery struct {
	// Search matches a fragment of the registry, a party's name or the
	// property's street.
	Search     string
	PropertyID *uuid.UUID
	PersonID   *uuid.UUID
	// Status, when set, keeps the contracts in that state on Today.
	Status domain.ContractStatus
	Today  domain.Date
	After  *ContractCursor
	Limit  int
}

// ContractCursor is where a page of the list ended.
type ContractCursor struct {
	StartsOn domain.Date
	ID       uuid.UUID
}

// ContractSummary is a row of the list.
type ContractSummary struct {
	Contract    domain.Contract
	Address     domain.Address
	TenantNames []string
}

// ContractPartyView is a party with who the person is.
type ContractPartyView struct {
	PersonID uuid.UUID
	Role     domain.PartyRole
	Name     string
	Kind     domain.PersonKind
}

// RentRecord is one stored instalment.
type RentRecord struct {
	ID       uuid.UUID
	Sequence int
	DueOn    domain.Date
	Amount   domain.Money
	// ChargesTotal is the sum of the charges billed with the rent.
	ChargesTotal domain.Money
	LateFee      domain.Money
	AmountPaid   *domain.Money
	PaidOn       *domain.Date
}

// ContractRepository stores contracts, bound to an organisation-scoped
// transaction like the others.
type ContractRepository interface {
	// Create stores the contract, its parties, acknowledgements and
	// instalments. An overlapping lease of the property is a validation error
	// on starts_on; a registry in use, on registry.
	Create(ctx context.Context, c *domain.Contract, schedule []domain.Instalment) error
	// Replace rewrites the contract as of version, its parties and
	// acknowledgements, and every instalment, reporting
	// domain.ErrPreconditionFailed when the version moved.
	Replace(ctx context.Context, c *domain.Contract, version int, schedule []domain.Instalment) error
	Get(ctx context.Context, id uuid.UUID) (*domain.Contract, []ContractPartyView, []RentRecord, error)
	List(ctx context.Context, q ContractQuery) ([]ContractSummary, error)
	// HasPayments reports whether any instalment was paid.
	HasPayments(ctx context.Context, id uuid.UUID) (bool, error)
	// Terminate records the termination day, as of version, and applies the
	// plan: instalments after its last one go, and the last one takes the
	// prorated amount when there is one.
	Terminate(ctx context.Context, id uuid.UUID, on domain.Date, version int, at time.Time, plan *domain.TerminationPlan) error
	Delete(ctx context.Context, id uuid.UUID) error
}

// ScopedRepositories are the stores of one office's business data, bound to a
// transaction scoped to it.
type ScopedRepositories struct {
	People     PersonRepository
	Properties PropertyRepository
	Contracts  ContractRepository
	Amendments AmendmentRepository
	Rents      RentRepository
	Dashboard  DashboardRepository
	Audit      AuditRepository
}

// RentView is one instalment with what identifies its contract.
type RentView struct {
	ID               uuid.UUID
	ContractID       uuid.UUID
	Registry         string
	Address          domain.Address
	TenantNames      []string
	Sequence         int
	DueOn            domain.Date
	Amount           domain.Money
	ChargesTotal     domain.Money
	LateFee          domain.Money
	AmountPaid       *domain.Money
	PaidOn           *domain.Date
	LatePenaltyRate  domain.Rate
	LateInterestRate domain.Rate
	// Charges is filled by Get only.
	Charges []domain.Charge
}

// Due is the rent with its charges, what a payment settles before any late fee.
func (r *RentView) Due() domain.Money {
	due, err := r.Amount.Add(r.ChargesTotal)
	if err != nil {
		return r.Amount
	}
	return due
}

// RentQuery filters the office's instalments. Status is "", "overdue",
// "pending" (unpaid, not yet due), "open" (unpaid) or "paid".
type RentQuery struct {
	Search     string
	Status     string
	DueFrom    *domain.Date
	DueTo      *domain.Date
	ContractID *uuid.UUID
	Today      domain.Date
	After      *RentCursor
	Limit      int
}

// RentCursor pages the list, which runs by due day.
type RentCursor struct {
	DueOn domain.Date
	ID    uuid.UUID
}

// RentRepository reads and settles instalments, bound to an
// organisation-scoped transaction.
type RentRepository interface {
	List(ctx context.Context, q RentQuery) ([]RentView, error)
	// Get is one instalment with its charges.
	Get(ctx context.Context, id uuid.UUID) (*RentView, error)
	// Pay settles an unpaid instalment; one already paid is ErrConflict, so
	// of two concurrent payments one fails.
	Pay(ctx context.Context, id uuid.UUID, p domain.Payment) error
	// Reverse puts a paid instalment back to unpaid; an unpaid one is ErrConflict.
	Reverse(ctx context.Context, id uuid.UUID) error
	// AddCharge adds a charge to an unpaid instalment; a paid one is ErrConflict.
	AddCharge(ctx context.Context, c *domain.Charge, at time.Time) error
	// RemoveCharge removes a charge from an unpaid instalment.
	RemoveCharge(ctx context.Context, rentID, chargeID uuid.UUID) error
	// HasCharges reports whether any instalment of a contract carries a charge.
	HasCharges(ctx context.Context, contractID uuid.UUID) (bool, error)
}

// MonthFigures are the receipts of a month.
type MonthFigures struct {
	// Expected is every instalment due in the month, rent and charges.
	Expected      domain.Money
	ExpectedCount int
	// Received is what came in during the month, whatever the due day.
	Received      domain.Money
	ReceivedCount int
	// Open is what is due in the month and not paid.
	Open      domain.Money
	OpenCount int
	// OfficeFee is the administration fee on the rents received in the month.
	OfficeFee domain.Money
}

// Portfolio is what the office manages today.
type Portfolio struct {
	Properties       int
	LeasedProperties int
	ActiveContracts  int
	// RentRoll is the sum of the current rents of the active contracts.
	RentRoll domain.Money
}

// ContractDeadline is a contract with a date coming up.
type ContractDeadline struct {
	ContractID uuid.UUID
	Registry   string
	Address    domain.Address
	On         domain.Date
}

// DashboardRepository answers the dashboard's figures.
type DashboardRepository interface {
	Month(ctx context.Context, from, to domain.Date) (MonthFigures, error)
	// Overdue is the count and the rent with charges of what is unpaid and past due.
	Overdue(ctx context.Context, today domain.Date) (int, domain.Money, error)
	Portfolio(ctx context.Context, today domain.Date) (Portfolio, error)
	// Expiring lists running contracts that end between today and until.
	Expiring(ctx context.Context, today, until domain.Date, limit int) ([]ContractDeadline, error)
	// AdjustmentsDue lists running contracts with an index whose twelve months
	// since the start or the last adjustment end by until.
	AdjustmentsDue(ctx context.Context, today, until domain.Date, limit int) ([]ContractDeadline, error)
}

// AmendmentRepository stores rent adjustments, bound to an organisation-scoped
// transaction.
type AmendmentRepository interface {
	// List is a contract's adjustments, oldest first.
	List(ctx context.Context, contractID uuid.UUID) ([]domain.Amendment, error)
	// Create records the adjustment and, as of the contract's version, moves
	// the contract and its unpaid instalments from sequence from on to the
	// new rent.
	Create(ctx context.Context, a *domain.Amendment, version, from int) error
	// Delete removes the adjustment and puts the previous rent back the same way.
	Delete(ctx context.Context, a *domain.Amendment, version, from int, at time.Time) error
}

// OrganizationScope runs work inside one office: a transaction in which the
// database shows that office's rows and no other's.
type OrganizationScope interface {
	InOrganization(ctx context.Context, organizationID uuid.UUID, fn func(ScopedRepositories) error) error
}

// Transactor runs work atomically.
//
// Registration creates an organisation, an account, a membership and an audit
// event; a member removed loses their memberships and their sessions. Each is
// one fact, so each is one transaction, and the repositories fn receives are
// bound to it.
type Transactor interface {
	InTx(ctx context.Context, fn func(Repositories) error) error
}

// PasswordHasher hashes and verifies passwords.
type PasswordHasher interface {
	Hash(password string) (string, error)
	Verify(password, hash string) error
}

// TokenIssuer mints and validates access tokens.
type TokenIssuer interface {
	IssueAccess(userID, organizationID uuid.UUID) (string, time.Time, error)
}

// Mailer sends one plain-text message to one address.
type Mailer interface {
	Send(ctx context.Context, to, subject, body string) error
}

// Sealer seals and opens a personal datum, and derives the blind index that
// still allows an exact lookup. The second factor's secret is the first thing
// to use it; phase 2's people are the reason it exists.
type Sealer interface {
	Seal(plaintext []byte, table, column string, rowID uuid.UUID) ([]byte, error)
	Open(sealed []byte, table, column string, rowID uuid.UUID) ([]byte, error)
	// Index derives the blind index of a normalised value within an office.
	Index(organizationID uuid.UUID, value string) []byte
}
