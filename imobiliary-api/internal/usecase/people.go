package usecase

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// People implements the office's register of people: individuals and
// companies, with their addresses, a spouse link and a company's
// representatives.
//
// Every operation runs inside the caller's office through OrganizationScope,
// reads included, so row-level security applies to all of them. Any member
// may manage people; the office is the controller of this data, and the
// service processes it on the office's behalf.
type People struct {
	scope    OrganizationScope
	sealer   Sealer
	now      Clock
	location *time.Location
	logger   *slog.Logger
	audit    *Auditor
}

// PeopleConfig collects the dependencies.
type PeopleConfig struct {
	Scope  OrganizationScope
	Sealer Sealer
	Now    Clock
	// Location is where "today" is, for the retention. UTC when nil.
	Location *time.Location
	Logger   *slog.Logger
}

// NewPeople wires the use case.
func NewPeople(cfg PeopleConfig) *People {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	return &People{
		scope:    cfg.Scope,
		sealer:   cfg.Sealer,
		now:      cfg.Now,
		location: cfg.Location,
		logger:   cfg.Logger,
		audit:    &Auditor{now: cfg.Now, logger: cfg.Logger},
	}
}

// Where each sealed field lives, which is also the context it is sealed
// against: a ciphertext copied to another column or row fails to open.
const (
	peopleTable      = "people"
	individualsTable = "individuals"
	companiesTable   = "companies"
)

// PeoplePage is one page of the list.
type PeoplePage struct {
	People []domain.PersonSummary
	// Next is where the following page starts, nil on the last page.
	Next *PersonCursor
}

// Page sizes of the list.
const (
	DefaultPeoplePageSize = 20
	MaxPeoplePageSize     = 100
)

// List searches the office's people. A query that is a valid CPF or CNPJ looks
// that document up exactly, through its blind index; anything else matches a
// fragment of the name, without regard to case or accents.
func (p *People) List(ctx context.Context, caller *Caller, search string, kind domain.PersonKind, after *PersonCursor, limit int) (*PeoplePage, error) {
	if kind != "" && kind != domain.PersonIndividual && kind != domain.PersonCompany {
		v := &domain.ValidationError{}
		v.Add("kind", "must be individual or company")
		return nil, v
	}
	switch {
	case limit <= 0:
		limit = DefaultPeoplePageSize
	case limit > MaxPeoplePageSize:
		limit = MaxPeoplePageSize
	}

	org := caller.Organization.ID
	q := PersonQuery{Kind: kind, After: after, Limit: limit + 1}
	if cpf, ok := domain.NormalizeCPF(search); ok {
		q.CPFIndex = p.sealer.Index(org, "cpf:"+cpf)
	} else if cnpj, ok := domain.NormalizeCNPJ(search); ok {
		q.CNPJIndex = p.sealer.Index(org, "cnpj:"+cnpj)
	} else {
		q.NameContains = search
	}

	var page PeoplePage
	err := p.scope.InOrganization(ctx, org, func(repos ScopedRepositories) error {
		people, cursors, err := repos.People.List(ctx, q)
		if err != nil {
			return err
		}
		if len(people) > limit {
			people = people[:limit]
			next := cursors[limit-1]
			page.Next = &next
		}
		page.People = people
		return nil
	})
	if err != nil {
		return nil, err
	}
	if page.People == nil {
		page.People = []domain.PersonSummary{}
	}
	return &page, nil
}

// Get reads one person, opening the sealed fields.
func (p *People) Get(ctx context.Context, caller *Caller, id uuid.UUID) (*domain.Person, error) {
	var person *domain.Person
	err := p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		stored, err := repos.People.Get(ctx, id)
		if err != nil {
			return err
		}
		person, err = p.open(stored)
		return err
	})
	return person, err
}

// Create registers a person.
func (p *People) Create(ctx context.Context, caller *Caller, person *domain.Person) (*domain.Person, error) {
	now := p.now().UTC()
	person.ID = uuid.NewV7()
	person.OrganizationID = caller.Organization.ID
	person.CreatedAt, person.UpdatedAt, person.Version = now, now, 1
	domain.NormalizePerson(person)
	if err := domain.ValidatePerson(person); err != nil {
		return nil, err
	}

	var created *domain.Person
	err := p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		if err := p.checkLinks(ctx, repos, person); err != nil {
			return err
		}
		stored, err := p.seal(person)
		if err != nil {
			return err
		}
		if err := repos.People.Create(ctx, stored); err != nil {
			return err
		}
		if err := p.linkSpouse(ctx, repos, person, nil, now); err != nil {
			return err
		}
		if err := p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionPersonCreated,
			EntityType:     "person",
			EntityID:       &person.ID,
		}); err != nil {
			return err
		}
		read, err := repos.People.Get(ctx, person.ID)
		if err != nil {
			return err
		}
		created, err = p.open(read)
		return err
	})
	return created, err
}

// Update replaces a person, provided the version it was based on is still the
// current one. The kind cannot change: an individual does not become a
// company, and their links would not survive it.
func (p *People) Update(ctx context.Context, caller *Caller, person *domain.Person, version int) (*domain.Person, error) {
	if version <= 0 {
		return nil, fmt.Errorf("update person: %w", domain.ErrPreconditionRequired)
	}
	now := p.now().UTC()
	person.OrganizationID = caller.Organization.ID
	person.UpdatedAt = now
	domain.NormalizePerson(person)
	if err := domain.ValidatePerson(person); err != nil {
		return nil, err
	}

	var updated *domain.Person
	err := p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		previousStored, err := repos.People.Get(ctx, person.ID)
		if err != nil {
			return err
		}
		previous, err := p.open(previousStored)
		if err != nil {
			return err
		}
		if previous.AnonymizedAt != nil {
			v := &domain.ValidationError{}
			v.Add("person", "the person was anonymized")
			return v
		}
		if previous.Kind != person.Kind {
			v := &domain.ValidationError{}
			v.Add("kind", "cannot change")
			return v
		}
		if previous.Version != version {
			return fmt.Errorf("update person: %w", domain.ErrPreconditionFailed)
		}
		if err := p.checkLinks(ctx, repos, person); err != nil {
			return err
		}
		stored, err := p.seal(person)
		if err != nil {
			return err
		}
		if err := repos.People.Update(ctx, stored, version); err != nil {
			return err
		}
		if err := p.linkSpouse(ctx, repos, person, previous.SpouseID, now); err != nil {
			return err
		}
		if err := p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionPersonUpdated,
			EntityType:     "person",
			EntityID:       &person.ID,
			Fields:         changedPersonFields(previous, person),
		}); err != nil {
			return err
		}
		read, err := repos.People.Get(ctx, person.ID)
		if err != nil {
			return err
		}
		updated, err = p.open(read)
		return err
	})
	return updated, err
}

// Delete removes a person for good. It is refused while anything links to
// them: a company they represent today, a property or a contract later.
// The spouse on the other side loses the link and keeps their record.
func (p *People) Delete(ctx context.Context, caller *Caller, id uuid.UUID) error {
	return p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		stored, err := repos.People.Get(ctx, id)
		if err != nil {
			return err
		}
		if err := repos.People.Delete(ctx, id); err != nil {
			return err
		}
		if spouse := stored.Person.SpouseID; spouse != nil {
			// The foreign key already cleared the column; this records that the
			// spouse's record changed.
			if err := repos.People.SetSpouse(ctx, *spouse, nil, p.now().UTC()); err != nil && !errors.Is(err, domain.ErrNotFound) {
				return err
			}
		}
		return p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionPersonDeleted,
			EntityType:     "person",
			EntityID:       &id,
		})
	})
}

// checkLinks applies the rules that read other people: a spouse is an
// individual in a marriage or stable union who is not married to someone else,
// and a representative is an individual.
func (p *People) checkLinks(ctx context.Context, repos ScopedRepositories, person *domain.Person) error {
	ids := slices.Clone(person.RepresentativeIDs)
	if person.SpouseID != nil {
		ids = append(ids, *person.SpouseID)
	}
	if len(ids) == 0 {
		return nil
	}
	links, err := repos.People.Links(ctx, ids)
	if err != nil {
		return err
	}

	v := &domain.ValidationError{}
	if id := person.SpouseID; id != nil {
		spouse, found := links[*id]
		switch {
		case !found:
			v.Add("spouse_id", "names a person that does not exist")
		case spouse.Kind != domain.PersonIndividual:
			v.Add("spouse_id", "must be an individual")
		case !spouse.MaritalStatus.HasPartner():
			v.Add("spouse_id", "must be registered as married or in a stable union")
		case spouse.SpouseID != nil && *spouse.SpouseID != person.ID:
			v.Add("spouse_id", "is already linked to another person")
		}
	}
	for _, id := range person.RepresentativeIDs {
		representative, found := links[id]
		switch {
		case !found:
			v.Add("representative_ids", "names a person that does not exist")
		case representative.Kind != domain.PersonIndividual:
			v.Add("representative_ids", "must be individuals")
		}
	}
	return v.OrNil()
}

// linkSpouse keeps the marriage link symmetrical: naming a spouse writes the
// link on their record too, and dropping or replacing one clears it there.
func (p *People) linkSpouse(ctx context.Context, repos ScopedRepositories, person *domain.Person, previous *uuid.UUID, at time.Time) error {
	current := person.SpouseID
	if previous != nil && (current == nil || *current != *previous) {
		if err := repos.People.SetSpouse(ctx, *previous, nil, at); err != nil && !errors.Is(err, domain.ErrNotFound) {
			return err
		}
	}
	if current != nil && (previous == nil || *current != *previous) {
		return repos.People.SetSpouse(ctx, *current, &person.ID, at)
	}
	return nil
}

// seal prepares a person for the repository: the sealed fields encrypted
// against their row and column, the documents with their blind indexes.
func (p *People) seal(person *domain.Person) (*StoredPerson, error) {
	stored := &StoredPerson{Person: *person}
	clear := &stored.Person
	clear.Email, clear.Phone, clear.CPF, clear.CNPJ, clear.BirthDate = "", "", "", "", domain.Date{}

	seal := func(value, table, column string) ([]byte, error) {
		if value == "" {
			return nil, nil
		}
		sealed, err := p.sealer.Seal([]byte(value), table, column, person.ID)
		if err != nil {
			return nil, fmt.Errorf("seal %s.%s: %w", table, column, err)
		}
		return sealed, nil
	}

	var err error
	if stored.Email, err = seal(person.Email, peopleTable, "email"); err != nil {
		return nil, err
	}
	if stored.Phone, err = seal(person.Phone, peopleTable, "phone"); err != nil {
		return nil, err
	}
	if stored.CPF, err = seal(person.CPF, individualsTable, "cpf"); err != nil {
		return nil, err
	}
	if person.CPF != "" {
		stored.CPFIndex = p.sealer.Index(person.OrganizationID, "cpf:"+person.CPF)
	}
	if stored.BirthDate, err = seal(person.BirthDate.String(), individualsTable, "birth_date"); err != nil {
		return nil, err
	}
	if stored.CNPJ, err = seal(person.CNPJ, companiesTable, "cnpj"); err != nil {
		return nil, err
	}
	if person.CNPJ != "" {
		stored.CNPJIndex = p.sealer.Index(person.OrganizationID, "cnpj:"+person.CNPJ)
	}
	return stored, nil
}

// open reverses seal.
func (p *People) open(stored *StoredPerson) (*domain.Person, error) {
	person := stored.Person
	open := func(sealed []byte, table, column string) (string, error) {
		if len(sealed) == 0 {
			return "", nil
		}
		plain, err := p.sealer.Open(sealed, table, column, person.ID)
		if err != nil {
			return "", fmt.Errorf("open %s.%s: %w", table, column, err)
		}
		return string(plain), nil
	}

	var err error
	if person.Email, err = open(stored.Email, peopleTable, "email"); err != nil {
		return nil, err
	}
	if person.Phone, err = open(stored.Phone, peopleTable, "phone"); err != nil {
		return nil, err
	}
	if person.CPF, err = open(stored.CPF, individualsTable, "cpf"); err != nil {
		return nil, err
	}
	if person.CNPJ, err = open(stored.CNPJ, companiesTable, "cnpj"); err != nil {
		return nil, err
	}
	birth, err := open(stored.BirthDate, individualsTable, "birth_date")
	if err != nil {
		return nil, err
	}
	if birth != "" {
		if person.BirthDate, err = domain.ParseDate(birth); err != nil {
			return nil, fmt.Errorf("open birth date: %w", err)
		}
	}
	return &person, nil
}

// changedPersonFields names what an update changed, for the audit trail. Names
// only: the trail must not become an unencrypted copy of a CPF.
func changedPersonFields(before, after *domain.Person) []string {
	var fields []string
	add := func(name string, changed bool) {
		if changed {
			fields = append(fields, name)
		}
	}
	add("name", before.Name != after.Name)
	add("email", before.Email != after.Email)
	add("phone", before.Phone != after.Phone)
	add("cpf", before.CPF != after.CPF)
	add("nationality", before.Nationality != after.Nationality)
	add("marital_status", before.MaritalStatus != after.MaritalStatus)
	add("property_regime", before.PropertyRegime != after.PropertyRegime)
	add("spouse_id", !sameID(before.SpouseID, after.SpouseID))
	add("occupation", before.Occupation != after.Occupation)
	add("birth_date", before.BirthDate != after.BirthDate)
	add("gender", before.Gender != after.Gender)
	add("cnpj", before.CNPJ != after.CNPJ)
	add("trade_name", before.TradeName != after.TradeName)
	add("representative_ids", !slices.Equal(before.RepresentativeIDs, after.RepresentativeIDs))
	add("addresses", !sameAddresses(before.Addresses, after.Addresses))
	return fields
}

func sameID(a, b *uuid.UUID) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameAddresses(a, b []domain.Address) bool {
	return slices.EqualFunc(a, b, func(x, y domain.Address) bool {
		x.ID, y.ID = uuid.UUID{}, uuid.UUID{}
		return x == y
	})
}
