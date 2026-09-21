package domain

import (
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"
	"uuid"
)

// A person is anyone an office deals with: an owner, a tenant, a guarantor, a
// company's representative. There is one entity for all of them because the
// same person is often more than one, and the role lives in the link that
// uses them (a property's owner, a contract's tenant), never in the person.
//
// A person is either an individual, identified by a CPF, or a company,
// identified by a CNPJ.

// PersonKind tells an individual from a company.
type PersonKind string

const (
	PersonIndividual PersonKind = "individual"
	PersonCompany    PersonKind = "company"
)

// MaritalStatus is an individual's civil status, as a contract qualifies it.
type MaritalStatus string

const (
	MaritalSingle      MaritalStatus = "single"
	MaritalMarried     MaritalStatus = "married"
	MaritalStableUnion MaritalStatus = "stable_union"
	MaritalDivorced    MaritalStatus = "divorced"
	MaritalSeparated   MaritalStatus = "separated"
	MaritalWidowed     MaritalStatus = "widowed"
)

var maritalStatuses = []MaritalStatus{
	MaritalSingle, MaritalMarried, MaritalStableUnion, MaritalDivorced, MaritalSeparated, MaritalWidowed,
}

// HasPartner reports whether the status comes with a spouse or partner, and
// so with a property regime.
func (s MaritalStatus) HasPartner() bool {
	return s == MaritalMarried || s == MaritalStableUnion
}

// PropertyRegime is the regime of assets of a marriage or stable union. It
// decides, among other things, whether a guarantor needs the spouse's consent
// (Civil Code art. 1.647, III), which phase 4 warns about.
type PropertyRegime string

const (
	RegimePartialCommunity    PropertyRegime = "partial_community"
	RegimeUniversalCommunity  PropertyRegime = "universal_community"
	RegimeTotalSeparation     PropertyRegime = "total_separation"
	RegimeMandatorySeparation PropertyRegime = "mandatory_separation"
	RegimeFinalParticipation  PropertyRegime = "final_participation"
)

var propertyRegimes = []PropertyRegime{
	RegimePartialCommunity, RegimeUniversalCommunity, RegimeTotalSeparation,
	RegimeMandatorySeparation, RegimeFinalParticipation,
}

// Gender exists for one declared purpose: grammatical agreement in the text of
// a contract ("o locatário", "a locatária"). It is optional.
type Gender string

const (
	GenderFemale Gender = "female"
	GenderMale   Gender = "male"
)

// AddressKind says what an address is used for.
type AddressKind string

const (
	AddressResidential    AddressKind = "residential"
	AddressCorrespondence AddressKind = "correspondence"
	AddressCommercial     AddressKind = "commercial"
)

// Length bounds of a person's free text.
const (
	MaxPersonNameLength   = 200
	MaxShortTextLength    = 120
	MaxObservationLength  = 500
	MaxAddressesPerPerson = 10
	MaxRepresentatives    = 10
)

// Address is where a person lives, receives mail or works. Each row has one
// owner: a person's address and a property's address are never the same row,
// so editing one can never move the other.
type Address struct {
	ID          uuid.UUID
	Kind        AddressKind
	IsPrimary   bool
	Street      string
	Number      string
	Complement  string
	District    string
	City        string
	State       string // UF, two letters
	ZipCode     string // CEP, eight digits
	Observation string
}

// Person is the entity, with the fields of its kind.
//
// The sealed fields (email, phone, CPF or CNPJ, birth date) are held here in
// the clear: sealing is the repository's concern, and the use case hands the
// repository both the value and its blind index.
type Person struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Kind           PersonKind
	// Name is the full name of an individual or the legal name of a company.
	Name    string
	Email   string
	Phone   string
	Version int

	// Individuals only.
	CPF            string
	Nationality    string
	MaritalStatus  MaritalStatus
	PropertyRegime PropertyRegime
	SpouseID       *uuid.UUID
	Occupation     string
	BirthDate      Date
	Gender         Gender

	// Companies only.
	CNPJ              string
	TradeName         string
	RepresentativeIDs []uuid.UUID

	Addresses []Address

	CreatedAt time.Time
	UpdatedAt time.Time
	// AnonymizedAt is when the office anonymised the record at the end of
	// the legal retention; nil otherwise. An anonymised record is never edited.
	AnonymizedAt *time.Time
}

// PersonSummary is a row of a list: enough to recognise someone, and nothing
// sealed. Listing never decrypts a document.
type PersonSummary struct {
	ID        uuid.UUID
	Kind      PersonKind
	Name      string
	TradeName string
	CreatedAt time.Time
}

// NormalizePerson trims the free text and reduces the documents, phone and
// postal codes to their canonical form, so that validation and storage see one
// spelling. Invalid documents are left as typed, for Validate to report.
func NormalizePerson(p *Person) {
	p.Name = collapseSpaces(p.Name)
	p.Email = NormalizeEmail(p.Email)
	p.Phone = strings.TrimSpace(p.Phone)
	if digits, ok := NormalizePhone(p.Phone); ok {
		p.Phone = digits
	}
	p.CPF = strings.TrimSpace(p.CPF)
	if cpf, ok := NormalizeCPF(p.CPF); ok {
		p.CPF = cpf
	}
	p.CNPJ = strings.TrimSpace(p.CNPJ)
	if cnpj, ok := NormalizeCNPJ(p.CNPJ); ok {
		p.CNPJ = cnpj
	}
	p.Nationality = collapseSpaces(p.Nationality)
	p.Occupation = collapseSpaces(p.Occupation)
	p.TradeName = collapseSpaces(p.TradeName)
	for i := range p.Addresses {
		NormalizeAddress(&p.Addresses[i])
	}
}

// NormalizeAddress trims an address and reduces the UF to capitals and the CEP
// to its digits. A person's addresses and a property's use the same rules.
func NormalizeAddress(a *Address) {
	a.Street = collapseSpaces(a.Street)
	a.Number = collapseSpaces(a.Number)
	a.Complement = collapseSpaces(a.Complement)
	a.District = collapseSpaces(a.District)
	a.City = collapseSpaces(a.City)
	a.State = strings.ToUpper(strings.TrimSpace(a.State))
	a.ZipCode = digitsOnly(a.ZipCode)
	a.Observation = strings.TrimSpace(a.Observation)
}

// ValidatePerson checks a person as a whole, after NormalizePerson.
//
// Rules that need other rows (the spouse exists and is free, a representative
// is an individual of the same office, a document is not already registered)
// are the use case's, which can read them.
func ValidatePerson(p *Person) error {
	v := &ValidationError{}

	switch p.Kind {
	case PersonIndividual, PersonCompany:
	default:
		v.Add("kind", "must be individual or company")
		return v
	}

	switch n := utf8.RuneCountInString(p.Name); {
	case n == 0:
		v.Add("name", "is required")
	case n > MaxPersonNameLength:
		v.Addf("name", "must be at most %d characters", MaxPersonNameLength)
	}
	if p.Email != "" {
		if len(p.Email) > MaxEmailLength {
			v.Addf("email", "must be at most %d characters", MaxEmailLength)
		} else if _, err := mail.ParseAddress(p.Email); err != nil {
			v.Add("email", "is not a valid email address")
		}
	}
	if p.Phone != "" {
		if _, ok := NormalizePhone(p.Phone); !ok {
			v.Add("phone", "must have between 10 and 13 digits")
		}
	}

	if p.Kind == PersonIndividual {
		validateIndividual(v, p)
	} else {
		validateCompany(v, p)
	}
	validateAddresses(v, p.Addresses)
	return v.OrNil()
}

func validateIndividual(v *ValidationError, p *Person) {
	if p.CNPJ != "" {
		v.Add("cnpj", "belongs to a company")
	}
	if p.TradeName != "" {
		v.Add("trade_name", "belongs to a company")
	}
	if len(p.RepresentativeIDs) > 0 {
		v.Add("representative_ids", "belong to a company")
	}
	// The CPF identifies an individual, and the national identity card uses
	// the same number, so every individual carries one.
	switch _, ok := NormalizeCPF(p.CPF); {
	case p.CPF == "":
		v.Add("cpf", "is required")
	case !ok:
		v.Add("cpf", "is not a valid CPF")
	}
	checkLength(v, "nationality", p.Nationality, MaxShortTextLength)
	checkLength(v, "occupation", p.Occupation, MaxShortTextLength)

	if p.MaritalStatus != "" && !contains(maritalStatuses, p.MaritalStatus) {
		v.Add("marital_status", "is not a known marital status")
	}
	if p.PropertyRegime != "" {
		switch {
		case !contains(propertyRegimes, p.PropertyRegime):
			v.Add("property_regime", "is not a known property regime")
		case !p.MaritalStatus.HasPartner():
			v.Add("property_regime", "applies only to a marriage or stable union")
		}
	}
	if p.SpouseID != nil {
		switch {
		case !p.MaritalStatus.HasPartner():
			v.Add("spouse_id", "applies only to a marriage or stable union")
		case *p.SpouseID == p.ID:
			v.Add("spouse_id", "cannot be the person themselves")
		}
	}
	if p.Gender != "" && p.Gender != GenderFemale && p.Gender != GenderMale {
		v.Add("gender", "must be female or male")
	}
}

func validateCompany(v *ValidationError, p *Person) {
	if p.CPF != "" {
		v.Add("cpf", "belongs to an individual")
	}
	for _, individualOnly := range []struct {
		field string
		set   bool
	}{
		{"nationality", p.Nationality != ""},
		{"marital_status", p.MaritalStatus != ""},
		{"property_regime", p.PropertyRegime != ""},
		{"spouse_id", p.SpouseID != nil},
		{"occupation", p.Occupation != ""},
		{"birth_date", !p.BirthDate.IsZero()},
		{"gender", p.Gender != ""},
	} {
		if individualOnly.set {
			v.Add(individualOnly.field, "belongs to an individual")
		}
	}
	if p.CNPJ != "" {
		if _, ok := NormalizeCNPJ(p.CNPJ); !ok {
			v.Add("cnpj", "is not a valid CNPJ")
		}
	}
	checkLength(v, "trade_name", p.TradeName, MaxPersonNameLength)
	if len(p.RepresentativeIDs) > MaxRepresentatives {
		v.Addf("representative_ids", "must be at most %d", MaxRepresentatives)
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range p.RepresentativeIDs {
		if id == p.ID {
			v.Add("representative_ids", "cannot include the company itself")
		}
		if seen[id] {
			v.Add("representative_ids", "must not repeat a person")
		}
		seen[id] = true
	}
}

func validateAddresses(v *ValidationError, addresses []Address) {
	if len(addresses) > MaxAddressesPerPerson {
		v.Addf("addresses", "must be at most %d", MaxAddressesPerPerson)
		return
	}
	primaries := 0
	for i, a := range addresses {
		field := func(name string) string { return "addresses[" + itoa(i) + "]." + name }
		switch a.Kind {
		case AddressResidential, AddressCorrespondence, AddressCommercial:
		default:
			v.Add(field("kind"), "must be residential, correspondence or commercial")
		}
		if a.IsPrimary {
			primaries++
		}
		validateAddressLines(v, a, field)
	}
	if primaries > 1 {
		v.Add("addresses", "must have at most one primary address")
	}
}

// validateAddressLines checks the lines every address has, naming each field
// through field so a list and a single address report the same way.
func validateAddressLines(v *ValidationError, a Address, field func(string) string) {
	if a.Street == "" {
		v.Add(field("street"), "is required")
	}
	if a.City == "" {
		v.Add(field("city"), "is required")
	}
	if !IsState(a.State) {
		v.Add(field("state"), "is not a Brazilian state")
	}
	if len(a.ZipCode) != 8 {
		v.Add(field("zip_code"), "must have 8 digits")
	}
	checkLength(v, field("street"), a.Street, MaxShortTextLength)
	checkLength(v, field("number"), a.Number, 20)
	checkLength(v, field("complement"), a.Complement, MaxShortTextLength)
	checkLength(v, field("district"), a.District, MaxShortTextLength)
	checkLength(v, field("city"), a.City, MaxShortTextLength)
	checkLength(v, field("observation"), a.Observation, MaxObservationLength)
}

// states are the 26 states and the Federal District.
var states = []string{
	"AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
	"PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
}

// IsState reports whether uf is one of the 27 federative units.
func IsState(uf string) bool { return contains(states, uf) }

// NormalizePhone reduces a phone number to its digits and reports whether it
// has a plausible length: 10 or 11 for a Brazilian number with its area code,
// up to 13 with the country code.
func NormalizePhone(s string) (string, bool) {
	digits := digitsOnly(s)
	for _, r := range s {
		if !strings.ContainsRune("0123456789 ()-+.", r) {
			return "", false
		}
	}
	if n := len(digits); n < 10 || n > 13 {
		return "", false
	}
	return digits, true
}

func checkLength(v *ValidationError, field, value string, limit int) {
	if utf8.RuneCountInString(value) > limit {
		v.Addf(field, "must be at most %d characters", limit)
	}
}

func collapseSpaces(s string) string { return strings.Join(strings.Fields(s), " ") }

func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func contains[T comparable](list []T, item T) bool {
	for _, candidate := range list {
		if candidate == item {
			return true
		}
	}
	return false
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
