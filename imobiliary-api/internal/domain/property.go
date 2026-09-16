package domain

import (
	"strings"
	"time"
	"uuid"
)

// Property is a real estate unit an office manages: its one address, its
// registration numbers and who owns it, in what share.
//
// A property's address is its own row, never shared with a person's: moving
// an owner's mail address must not move the house.
type Property struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Address        Address
	// Registry is the matrícula at the real estate registry office, and
	// RegistryOffice names that office ("1º Cartório de Registro de Imóveis
	// de Bebedouro").
	Registry       string
	RegistryOffice string
	// MunicipalRegistration is the city's property tax (IPTU) registration.
	MunicipalRegistration string
	// WaterCode and EnergyCode are the utility account numbers, which a
	// contract names so the tenant can transfer the bills.
	WaterCode  string
	EnergyCode string
	Owners     []PropertyOwner
	Version    int
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// PropertyOwner is a person's share of a property. Shares are rates, so 50%
// is 500000 and a third can be written 33.3333.
type PropertyOwner struct {
	PersonID uuid.UUID
	Share    Rate
}

// PropertySummary is a row of the list: the address to recognise the property
// and the owners' names to tell apart two in the same building.
type PropertySummary struct {
	ID         uuid.UUID
	Address    Address
	Registry   string
	OwnerNames []string
	CreatedAt  time.Time
}

// FullShare is 100%, what a property's owners' shares must add up to.
const FullShare Rate = RateScale

// Limits of a property's registration fields and owners.
const (
	MaxRegistryLength = 60
	MaxOwners         = 20
)

// NormalizeProperty trims the free text and the address.
func NormalizeProperty(p *Property) {
	NormalizeAddress(&p.Address)
	p.Address.Kind, p.Address.IsPrimary = "", false
	p.Registry = collapseSpaces(p.Registry)
	p.RegistryOffice = collapseSpaces(p.RegistryOffice)
	p.MunicipalRegistration = collapseSpaces(p.MunicipalRegistration)
	p.WaterCode = strings.TrimSpace(p.WaterCode)
	p.EnergyCode = strings.TrimSpace(p.EnergyCode)
}

// ValidateProperty checks a property, after NormalizeProperty.
//
// An owner that does not exist in the office is the use case's to report: it
// takes a read.
func ValidateProperty(p *Property) error {
	v := &ValidationError{}
	validateAddressLines(v, p.Address, func(name string) string { return "address." + name })

	checkLength(v, "registry", p.Registry, MaxRegistryLength)
	checkLength(v, "registry_office", p.RegistryOffice, MaxShortTextLength)
	checkLength(v, "municipal_registration", p.MunicipalRegistration, MaxRegistryLength)
	checkLength(v, "water_code", p.WaterCode, MaxRegistryLength)
	checkLength(v, "energy_code", p.EnergyCode, MaxRegistryLength)

	switch {
	case len(p.Owners) == 0:
		v.Add("owners", "must name at least one owner")
	case len(p.Owners) > MaxOwners:
		v.Addf("owners", "must be at most %d", MaxOwners)
	default:
		seen := map[uuid.UUID]bool{}
		var total int64
		for i, owner := range p.Owners {
			field := "owners[" + itoa(i) + "]"
			if seen[owner.PersonID] {
				v.Add(field+".person_id", "must not repeat a person")
			}
			seen[owner.PersonID] = true
			if owner.Share <= 0 || owner.Share > FullShare {
				v.Add(field+".share", "must be greater than 0 and at most 100")
			}
			total += int64(owner.Share)
		}
		// The sum is exact: shares are integers in millionths, so a third
		// written 33.3333 three times is 99.9999 and is refused, as it should
		// be. The last owner takes the remainder.
		if total != int64(FullShare) {
			v.Add("owners", "shares must add up to exactly 100")
		}
	}
	return v.OrNil()
}
