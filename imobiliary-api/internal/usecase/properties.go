package usecase

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"time"
	"uuid"

	"imobiliary/internal/domain"
)

// Properties implements the office's register of properties: the address,
// the registration numbers, and the owners with their shares.
//
// Like People, every operation runs inside the caller's office, and any member
// may manage properties.
type Properties struct {
	scope  OrganizationScope
	now    Clock
	logger *slog.Logger
	audit  *Auditor
}

// PropertiesConfig collects the dependencies.
type PropertiesConfig struct {
	Scope  OrganizationScope
	Now    Clock
	Logger *slog.Logger
}

// NewProperties wires the use case.
func NewProperties(cfg PropertiesConfig) *Properties {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Properties{
		scope:  cfg.Scope,
		now:    cfg.Now,
		logger: cfg.Logger,
		audit:  &Auditor{now: cfg.Now, logger: cfg.Logger},
	}
}

// PropertyView is a property with its owners named.
type PropertyView struct {
	Property *domain.Property
	Owners   []PropertyOwnerView
}

// PropertiesPage is one page of the list.
type PropertiesPage struct {
	Properties []domain.PropertySummary
	Next       *PropertyCursor
}

// List searches the office's properties by a fragment of the address, the
// registry or the municipal registration, and optionally by owner.
func (p *Properties) List(ctx context.Context, caller *Caller, search string, ownerID *uuid.UUID, after *PropertyCursor, limit int) (*PropertiesPage, error) {
	switch {
	case limit <= 0:
		limit = DefaultPeoplePageSize
	case limit > MaxPeoplePageSize:
		limit = MaxPeoplePageSize
	}
	q := PropertyQuery{AddressContains: search, OwnerID: ownerID, After: after, Limit: limit + 1}

	page := &PropertiesPage{Properties: []domain.PropertySummary{}}
	err := p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		rows, cursors, err := repos.Properties.List(ctx, q)
		if err != nil {
			return err
		}
		if len(rows) > limit {
			rows = rows[:limit]
			next := cursors[limit-1]
			page.Next = &next
		}
		if rows != nil {
			page.Properties = rows
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return page, nil
}

// Get reads one property with its owners.
func (p *Properties) Get(ctx context.Context, caller *Caller, id uuid.UUID) (*PropertyView, error) {
	var view *PropertyView
	err := p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		property, owners, err := repos.Properties.Get(ctx, id)
		if err != nil {
			return err
		}
		view = &PropertyView{Property: property, Owners: owners}
		return nil
	})
	return view, err
}

// Create registers a property.
func (p *Properties) Create(ctx context.Context, caller *Caller, property *domain.Property) (*PropertyView, error) {
	now := p.now().UTC()
	property.ID = uuid.NewV7()
	property.OrganizationID = caller.Organization.ID
	property.CreatedAt, property.UpdatedAt, property.Version = now, now, 1
	domain.NormalizeProperty(property)
	if err := domain.ValidateProperty(property); err != nil {
		return nil, err
	}

	var view *PropertyView
	err := p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		if err := checkOwners(ctx, repos, property); err != nil {
			return err
		}
		if err := repos.Properties.Create(ctx, property); err != nil {
			return err
		}
		if err := p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionPropertyCreated,
			EntityType:     "property",
			EntityID:       &property.ID,
		}); err != nil {
			return err
		}
		read, owners, err := repos.Properties.Get(ctx, property.ID)
		view = &PropertyView{Property: read, Owners: owners}
		return err
	})
	if err != nil {
		return nil, err
	}
	return view, nil
}

// Update replaces a property as of the version the edit was based on.
func (p *Properties) Update(ctx context.Context, caller *Caller, property *domain.Property, version int) (*PropertyView, error) {
	if version <= 0 {
		return nil, fmt.Errorf("update property: %w", domain.ErrPreconditionRequired)
	}
	property.OrganizationID = caller.Organization.ID
	property.UpdatedAt = p.now().UTC()
	domain.NormalizeProperty(property)
	if err := domain.ValidateProperty(property); err != nil {
		return nil, err
	}

	var view *PropertyView
	err := p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		previous, _, err := repos.Properties.Get(ctx, property.ID)
		if err != nil {
			return err
		}
		if previous.Version != version {
			return fmt.Errorf("update property: %w", domain.ErrPreconditionFailed)
		}
		if err := checkOwners(ctx, repos, property); err != nil {
			return err
		}
		if err := repos.Properties.Update(ctx, property, version); err != nil {
			return err
		}
		if err := p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionPropertyUpdated,
			EntityType:     "property",
			EntityID:       &property.ID,
			Fields:         changedPropertyFields(previous, property),
		}); err != nil {
			return err
		}
		read, owners, err := repos.Properties.Get(ctx, property.ID)
		view = &PropertyView{Property: read, Owners: owners}
		return err
	})
	if err != nil {
		return nil, err
	}
	return view, nil
}

// Delete removes a property with its owners and its address. It will be
// refused, once contracts exist, while one points at the property.
func (p *Properties) Delete(ctx context.Context, caller *Caller, id uuid.UUID) error {
	return p.scope.InOrganization(ctx, caller.Organization.ID, func(repos ScopedRepositories) error {
		if err := repos.Properties.Delete(ctx, id); err != nil {
			return err
		}
		return p.audit.recordWith(ctx, repos.Audit, AuditEntry{
			OrganizationID: &caller.Organization.ID,
			ActorID:        &caller.User.ID,
			Action:         domain.ActionPropertyDeleted,
			EntityType:     "property",
			EntityID:       &id,
		})
	})
}

// checkOwners reports owners that are not people of this office. Row-level
// security makes another office's person look the same as a missing one.
func checkOwners(ctx context.Context, repos ScopedRepositories, property *domain.Property) error {
	ids := make([]uuid.UUID, 0, len(property.Owners))
	for _, owner := range property.Owners {
		ids = append(ids, owner.PersonID)
	}
	links, err := repos.People.Links(ctx, ids)
	if err != nil {
		return err
	}
	v := &domain.ValidationError{}
	for i, owner := range property.Owners {
		if _, found := links[owner.PersonID]; !found {
			v.Addf(fmt.Sprintf("owners[%d].person_id", i), "names a person that does not exist")
		}
	}
	return v.OrNil()
}

// changedPropertyFields names what an update changed, for the audit trail.
func changedPropertyFields(before, after *domain.Property) []string {
	var fields []string
	add := func(name string, changed bool) {
		if changed {
			fields = append(fields, name)
		}
	}
	a, b := before.Address, after.Address
	a.ID, b.ID = uuid.UUID{}, uuid.UUID{}
	add("address", a != b)
	add("registry", before.Registry != after.Registry)
	add("registry_office", before.RegistryOffice != after.RegistryOffice)
	add("municipal_registration", before.MunicipalRegistration != after.MunicipalRegistration)
	add("water_code", before.WaterCode != after.WaterCode)
	add("energy_code", before.EnergyCode != after.EnergyCode)
	add("owners", !slices.Equal(before.Owners, after.Owners))
	return fields
}
