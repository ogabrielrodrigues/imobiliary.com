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

// propertyAddressBody is a property's address: the lines of any address,
// without the kind and primary flag a person's addresses carry.
type propertyAddressBody struct {
	Street      string `json:"street"`
	Number      string `json:"number"`
	Complement  string `json:"complement"`
	District    string `json:"district"`
	City        string `json:"city"`
	State       string `json:"state"`
	ZipCode     string `json:"zip_code"`
	Observation string `json:"observation"`
}

func presentPropertyAddress(a domain.Address) propertyAddressBody {
	return propertyAddressBody{
		Street: a.Street, Number: a.Number, Complement: a.Complement, District: a.District,
		City: a.City, State: a.State, ZipCode: a.ZipCode, Observation: a.Observation,
	}
}

type propertyOwnerBody struct {
	PersonID string            `json:"person_id"`
	Share    domain.Rate       `json:"share"`
	Name     string            `json:"name"`
	Kind     domain.PersonKind `json:"kind"`
}

type propertyBody struct {
	ID                    string              `json:"id"`
	Address               propertyAddressBody `json:"address"`
	Registry              string              `json:"registry"`
	RegistryOffice        string              `json:"registry_office"`
	MunicipalRegistration string              `json:"municipal_registration"`
	WaterCode             string              `json:"water_code"`
	EnergyCode            string              `json:"energy_code"`
	Owners                []propertyOwnerBody `json:"owners"`
	Version               int                 `json:"version"`
	CreatedAt             time.Time           `json:"created_at"`
	UpdatedAt             time.Time           `json:"updated_at"`
}

func presentProperty(view *usecase.PropertyView) propertyBody {
	p := view.Property
	out := propertyBody{
		ID: p.ID.String(), Address: presentPropertyAddress(p.Address), Registry: p.Registry,
		RegistryOffice: p.RegistryOffice, MunicipalRegistration: p.MunicipalRegistration,
		WaterCode: p.WaterCode, EnergyCode: p.EnergyCode, Version: p.Version,
		CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
		Owners: make([]propertyOwnerBody, 0, len(view.Owners)),
	}
	for _, o := range view.Owners {
		out.Owners = append(out.Owners, propertyOwnerBody{
			PersonID: o.PersonID.String(), Share: o.Share, Name: o.Name, Kind: o.Kind,
		})
	}
	return out
}

type propertyRequest struct {
	Address               propertyAddressBody `json:"address"`
	Registry              string              `json:"registry"`
	RegistryOffice        string              `json:"registry_office"`
	MunicipalRegistration string              `json:"municipal_registration"`
	WaterCode             string              `json:"water_code"`
	EnergyCode            string              `json:"energy_code"`
	Owners                []struct {
		PersonID string `json:"person_id"`
		// A string, like every rate this API reads, so "33.3333" arrives
		// exactly; parsed here to report a bad one on its field.
		Share string `json:"share"`
	} `json:"owners"`
}

func (body propertyRequest) toProperty() (*domain.Property, error) {
	v := &domain.ValidationError{}
	a := body.Address
	p := &domain.Property{
		Address: domain.Address{
			Street: a.Street, Number: a.Number, Complement: a.Complement, District: a.District,
			City: a.City, State: a.State, ZipCode: a.ZipCode, Observation: a.Observation,
		},
		Registry: body.Registry, RegistryOffice: body.RegistryOffice,
		MunicipalRegistration: body.MunicipalRegistration,
		WaterCode:             body.WaterCode, EnergyCode: body.EnergyCode,
	}
	for i, o := range body.Owners {
		field := "owners[" + strconv.Itoa(i) + "]"
		id, err := uuid.Parse(o.PersonID)
		if err != nil {
			v.Add(field+".person_id", "is not a valid identifier")
		}
		share, err := domain.ParseRate(o.Share)
		if err != nil {
			v.Add(field+".share", "must be a percentage with up to four decimal places, such as 50 or 33.3333")
		}
		p.Owners = append(p.Owners, domain.PropertyOwner{PersonID: id, Share: share})
	}
	return p, v.OrNil()
}

type propertySummaryBody struct {
	ID         string              `json:"id"`
	Address    propertyAddressBody `json:"address"`
	Registry   string              `json:"registry"`
	OwnerNames []string            `json:"owner_names"`
	CreatedAt  time.Time           `json:"created_at"`
}

type propertiesPageBody struct {
	Properties []propertySummaryBody `json:"properties"`
	NextCursor string                `json:"next_cursor,omitzero"`
}

func encodePropertyCursor(c *usecase.PropertyCursor) string {
	raw, _ := json.Marshal(cursorBody{Key: c.SortKey, ID: c.ID.String()})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodePropertyCursor(s string) (*usecase.PropertyCursor, error) {
	person, err := decodeCursor(s)
	if err != nil {
		return nil, err
	}
	return &usecase.PropertyCursor{SortKey: person.SortKey, ID: person.ID}, nil
}

// --- handlers ---------------------------------------------------------------

func (s *Server) handleListProperties(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	var after *usecase.PropertyCursor
	if raw := query.Get("cursor"); raw != "" {
		cursor, err := decodePropertyCursor(raw)
		if err != nil {
			writeError(w, s.logger, err)
			return
		}
		after = cursor
	}
	var owner *uuid.UUID
	if raw := query.Get("owner_id"); raw != "" {
		id, err := requiredUUID("owner_id", raw)
		if err != nil {
			writeError(w, s.logger, err)
			return
		}
		owner = &id
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

	page, err := s.properties.List(r.Context(), callerFrom(r.Context()),
		strings.TrimSpace(query.Get("q")), owner, after, limit)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	out := propertiesPageBody{Properties: make([]propertySummaryBody, 0, len(page.Properties))}
	for _, p := range page.Properties {
		names := p.OwnerNames
		if names == nil {
			names = []string{}
		}
		out.Properties = append(out.Properties, propertySummaryBody{
			ID: p.ID.String(), Address: presentPropertyAddress(p.Address), Registry: p.Registry,
			OwnerNames: names, CreatedAt: p.CreatedAt,
		})
	}
	if page.Next != nil {
		out.NextCursor = encodePropertyCursor(page.Next)
	}
	writeJSON(w, s.logger, http.StatusOK, out)
}

func (s *Server) handleCreateProperty(w http.ResponseWriter, r *http.Request) {
	var body propertyRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	property, err := body.toProperty()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	view, err := s.properties.Create(r.Context(), callerFrom(r.Context()), property)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeProperty(w, s, http.StatusCreated, view)
}

func (s *Server) handleGetProperty(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("property_id", r.PathValue("propertyID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	view, err := s.properties.Get(r.Context(), callerFrom(r.Context()), id)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeProperty(w, s, http.StatusOK, view)
}

func (s *Server) handleUpdateProperty(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("property_id", r.PathValue("propertyID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	version := ifMatchVersion(r)
	var body propertyRequest
	if err := decodeJSON(r, &body); err != nil {
		writeDecodeError(w, s.logger, err)
		return
	}
	property, err := body.toProperty()
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	property.ID = id
	view, err := s.properties.Update(r.Context(), callerFrom(r.Context()), property, version)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeProperty(w, s, http.StatusOK, view)
}

func (s *Server) handleDeleteProperty(w http.ResponseWriter, r *http.Request) {
	id, err := requiredUUID("property_id", r.PathValue("propertyID"))
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	if err := s.properties.Delete(r.Context(), callerFrom(r.Context()), id); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeProperty(w http.ResponseWriter, s *Server, status int, view *usecase.PropertyView) {
	w.Header().Set("ETag", strconv.Quote(strconv.Itoa(view.Property.Version)))
	writeJSON(w, s.logger, status, presentProperty(view))
}
