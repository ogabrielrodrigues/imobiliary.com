package http

import (
	"encoding/base64"
	json "encoding/json/v2"
	"net/http"
	"strconv"
	"strings"
	"time"
	"uuid"

	"imobiliary/internal/domain"
	"imobiliary/internal/usecase"
)

// --- shapes -----------------------------------------------------------------

type addressBody struct {
	ID          string             `json:"id,omitzero"`
	Kind        domain.AddressKind `json:"kind"`
	IsPrimary   bool               `json:"is_primary"`
	Street      string             `json:"street"`
	Number      string             `json:"number"`
	Complement  string             `json:"complement"`
	District    string             `json:"district"`
	City        string             `json:"city"`
	State       string             `json:"state"`
	ZipCode     string             `json:"zip_code"`
	Observation string             `json:"observation"`
}

// personBody is a person as the API shows it. Every field is present on both
// kinds, empty when it belongs to the other, so a client reads one shape.
type personBody struct {
	ID                string                `json:"id"`
	Kind              domain.PersonKind     `json:"kind"`
	Name              string                `json:"name"`
	Email             string                `json:"email"`
	Phone             string                `json:"phone"`
	CPF               string                `json:"cpf"`
	Nationality       string                `json:"nationality"`
	MaritalStatus     domain.MaritalStatus  `json:"marital_status"`
	PropertyRegime    domain.PropertyRegime `json:"property_regime"`
	SpouseID          *string               `json:"spouse_id"`
	Occupation        string                `json:"occupation"`
	BirthDate         *string               `json:"birth_date"`
	Gender            domain.Gender         `json:"gender"`
	CNPJ              string                `json:"cnpj"`
	TradeName         string                `json:"trade_name"`
	RepresentativeIDs []string              `json:"representative_ids"`
	Addresses         []addressBody         `json:"addresses"`
	Version           int                   `json:"version"`
	CreatedAt         time.Time             `json:"created_at"`
	UpdatedAt         time.Time             `json:"updated_at"`
	AnonymizedAt      *time.Time            `json:"anonymized_at"`
}

func presentPerson(p *domain.Person) personBody {
	out := personBody{
		ID: p.ID.String(), Kind: p.Kind, Name: p.Name, Email: p.Email, Phone: p.Phone,
		Nationality: p.Nationality, MaritalStatus: p.MaritalStatus, PropertyRegime: p.PropertyRegime,
		SpouseID: optionalID(p.SpouseID), Occupation: p.Occupation, Gender: p.Gender,
		TradeName: p.TradeName, Version: p.Version, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
		AnonymizedAt:      p.AnonymizedAt,
		RepresentativeIDs: make([]string, 0, len(p.RepresentativeIDs)),
		Addresses:         make([]addressBody, 0, len(p.Addresses)),
	}
	// Documents leave formatted, the way a person reads and types them.
	if p.CPF != "" {
		out.CPF = domain.FormatCPF(p.CPF)
	}
	if p.CNPJ != "" {
		out.CNPJ = domain.FormatCNPJ(p.CNPJ)
	}
	if !p.BirthDate.IsZero() {
		date := p.BirthDate.String()
		out.BirthDate = &date
	}
	for _, id := range p.RepresentativeIDs {
		out.RepresentativeIDs = append(out.RepresentativeIDs, id.String())
	}
	for _, a := range p.Addresses {
		out.Addresses = append(out.Addresses, addressBody{
			ID: a.ID.String(), Kind: a.Kind, IsPrimary: a.IsPrimary, Street: a.Street, Number: a.Number,
			Complement: a.Complement, District: a.District, City: a.City, State: a.State,
			ZipCode: a.ZipCode, Observation: a.Observation,
		})
	}
	return out
}

// personRequest is what a client sends to create or replace a person.
type personRequest struct {
	Kind              domain.PersonKind     `json:"kind"`
	Name              string                `json:"name"`
	Email             string                `json:"email"`
	Phone             string                `json:"phone"`
	CPF               string                `json:"cpf"`
	Nationality       string                `json:"nationality"`
	MaritalStatus     domain.MaritalStatus  `json:"marital_status"`
	PropertyRegime    domain.PropertyRegime `json:"property_regime"`
	SpouseID          *string               `json:"spouse_id"`
	Occupation        string                `json:"occupation"`
	BirthDate         *string               `json:"birth_date"`
	Gender            domain.Gender         `json:"gender"`
	CNPJ              string                `json:"cnpj"`
	TradeName         string                `json:"trade_name"`
	RepresentativeIDs []string              `json:"representative_ids"`
	Addresses         []addressBody         `json:"addresses"`
}

// toPerson reads the request into the entity, reporting identifiers and dates
// it cannot parse as field errors.
func (body personRequest) toPerson() (*domain.Person, error) {
	v := &domain.ValidationError{}
	p := &domain.Person{
		Kind: body.Kind, Name: body.Name, Email: body.Email, Phone: body.Phone, CPF: body.CPF,
		Nationality: body.Nationality, MaritalStatus: body.MaritalStatus, PropertyRegime: body.PropertyRegime,
		Occupation: body.Occupation, Gender: body.Gender, CNPJ: body.CNPJ, TradeName: body.TradeName,
	}
	if body.SpouseID != nil && *body.SpouseID != "" {
		if id, err := uuid.Parse(*body.SpouseID); err == nil {
			p.SpouseID = &id
		} else {
			v.Add("spouse_id", "is not a valid identifier")
		}
	}
	if body.BirthDate != nil && *body.BirthDate != "" {
		if date, err := domain.ParseDate(*body.BirthDate); err == nil {
			p.BirthDate = date
		} else {
			v.Add("birth_date", "must be a date written YYYY-MM-DD")
		}
	}
	for _, raw := range body.RepresentativeIDs {
		id, err := uuid.Parse(raw)
		if err != nil {
			v.Add("representative_ids", "must be valid identifiers")
			break
		}
		p.RepresentativeIDs = append(p.RepresentativeIDs, id)
	}
	for _, a := range body.Addresses {
		p.Addresses = append(p.Addresses, domain.Address{
			Kind: a.Kind, IsPrimary: a.IsPrimary, Street: a.Street, Number: a.Number,
			Complement: a.Complement, District: a.District, City: a.City, State: a.State,
			ZipCode: a.ZipCode, Observation: a.Observation,
		})
	}
	return p, v.OrNil()
}

type personSummaryBody struct {
	ID        string            `json:"id"`
	Kind      domain.PersonKind `json:"kind"`
	Name      string            `json:"name"`
	TradeName string            `json:"trade_name"`
	CreatedAt time.Time         `json:"created_at"`
}

type peoplePageBody struct {
	People     []personSummaryBody `json:"people"`
	NextCursor string              `json:"next_cursor,omitzero"`
}

// cursorBody is the opaque page cursor, base64url JSON. Opaque to the client,
// not secret: it holds a folded name the client already listed.
type cursorBody struct {
	Key string `json:"k"`
	ID  string `json:"id"`
}

func encodeCursor(c *usecase.PersonCursor) string {
	raw, _ := json.Marshal(cursorBody{Key: c.SortKey, ID: c.ID.String()})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeCursor(s string) (*usecase.PersonCursor, error) {
	invalid := func() error {
		v := &domain.ValidationError{}
		v.Add("cursor", "is not a cursor this API issued")
		return v
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, invalid()
	}
	var body cursorBody
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, invalid()
	}
	id, err := uuid.Parse(body.ID)
	if err != nil {
		return nil, invalid()
	}
	return &usecase.PersonCursor{SortKey: body.Key, ID: id}, nil
}

// --- handlers ---------------------------------------------------------------

func (s *Server) handleListPeople(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	var after *usecase.PersonCursor
	if raw := query.Get("cursor"); raw != "" {
		cursor, err := decodeCursor(raw)
		if err != nil {
			writeError(w, s.logger, err)
			return
		}
		after = cursor
	}
	limit := 0
	if raw := query.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			v := &domain.ValidationError{}
			v.Add("limit", "must be a positive integer")
			writeError(w, s.logger, v)
			return
		}
		limit = n
	}

	page, err := s.people.List(r.Context(), callerFrom(r.Context()),
		strings.TrimSpace(query.Get("q")), domain.PersonKind(query.Get("kind")), after, limit)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := peoplePageBody{People: make([]personSummaryBody, 0, len(page.People))}
	for _, p := range page.People {
		out.People = append(out.People, personSummaryBody{
			ID: p.ID.String(), Kind: p.Kind, Name: p.Name, TradeName: p.TradeName, CreatedAt: p.CreatedAt,
		})
	}
	if page.Next != nil {
		out.NextCursor = encodeCursor(page.Next)
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) handleCreatePerson(w http.ResponseWriter, r *http.Request) {
	var body personRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	person, err := body.toPerson()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	created, err := s.people.Create(r.Context(), callerFrom(r.Context()), person)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writePerson(w, s, http.StatusCreated, created)
}

func (s *Server) handleGetPerson(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("person_id", r.PathValue("personID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	person, err := s.people.Get(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writePerson(w, s, http.StatusOK, person)
}

// handleUpdatePerson replaces a person. If-Match must carry the version the
// edit was based on, as the ETag of the read gave it; without it a concurrent
// edit would be silently overwritten.
func (s *Server) handleUpdatePerson(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("person_id", r.PathValue("personID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	version := ifMatchVersion(r)
	var body personRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	person, err := body.toPerson()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	person.ID = id
	updated, err := s.people.Update(r.Context(), callerFrom(r.Context()), person, version)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writePerson(w, s, http.StatusOK, updated)
}

func (s *Server) handleDeletePerson(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("person_id", r.PathValue("personID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	if err := s.people.Delete(r.Context(), callerFrom(r.Context()), id); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writePerson(w http.ResponseWriter, s *Server, status int, p *domain.Person) {
	w.Header().Set("ETag", strconv.Quote(strconv.Itoa(p.Version)))
	writeJSON(w, s.logger, status, presentPerson(p))
}

// ifMatchVersion reads the version from If-Match, accepting the quoted form
// the ETag gave and a weak prefix. Anything unreadable is 0, which the use case
// answers as a missing precondition.
func ifMatchVersion(r *http.Request) int {
	raw := strings.TrimSpace(r.Header.Get("If-Match"))
	raw = strings.TrimPrefix(raw, "W/")
	raw = strings.Trim(raw, `"`)
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 {
		return 0
	}
	return n
}

// --- anonymisation ---------------------------------------------------------------

type candidateContractBody struct {
	ID             string `json:"id"`
	Registry       string `json:"registry"`
	DocumentsCanGo bool   `json:"documents_can_go"`
}

type candidatePayoutBody struct {
	ID     string `json:"id"`
	Number string `json:"number"`
}

type anonymizationCandidateBody struct {
	Person         personRefBody           `json:"person"`
	LastActivityOn domain.Date             `json:"last_activity_on"`
	RetentionEnded domain.Date             `json:"retention_ended_on"`
	Contracts      []candidateContractBody `json:"contracts"`
	Payouts        []candidatePayoutBody   `json:"payouts"`
}

func (s *Server) handleAnonymizationCandidates(w http.ResponseWriter, r *http.Request) {
	found, err := s.people.AnonymizationCandidates(r.Context(), callerFrom(r.Context()))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := struct {
		Candidates []anonymizationCandidateBody `json:"candidates"`
	}{Candidates: make([]anonymizationCandidateBody, 0, len(found))}
	for _, c := range found {
		body := anonymizationCandidateBody{
			Person:         personRefBody{ID: c.Person.ID.String(), Name: c.Person.Name, Kind: c.Person.Kind},
			LastActivityOn: c.LastActivity, RetentionEnded: c.RetentionEnded,
			Contracts: make([]candidateContractBody, 0, len(c.Contracts)),
			Payouts:   make([]candidatePayoutBody, 0, len(c.Payouts)),
		}
		for _, k := range c.Contracts {
			body.Contracts = append(body.Contracts, candidateContractBody{ID: k.ID.String(), Registry: k.Registry, DocumentsCanGo: k.DocumentsCanGo})
		}
		for _, p := range c.Payouts {
			body.Payouts = append(body.Payouts, candidatePayoutBody{ID: p.ID.String(), Number: p.Number})
		}
		out.Candidates = append(out.Candidates, body)
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) handleAnonymizePerson(w http.ResponseWriter, r *http.Request) {
	id, ok := s.personID(w, r)
	if !ok {
		return
	}
	if err := s.people.Anonymize(r.Context(), callerFrom(r.Context()), id); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
