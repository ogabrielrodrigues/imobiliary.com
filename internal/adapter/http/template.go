package http

import (
	"mime/multipart"
	"net/http"
	"time"

	"docgen/internal/domain"
)

// multipartMemory is how much of an upload is buffered in memory before the
// rest spills to a temporary file.
const multipartMemory = 1 << 20

// templateResponse presents a template together with its latest version.
type templateResponse struct {
	ID            string           `json:"id"`
	Name          string           `json:"name"`
	Description   string           `json:"description"`
	LatestVersion int              `json:"latest_version"`
	CreatedAt     time.Time        `json:"created_at"`
	UpdatedAt     time.Time        `json:"updated_at"`
	Version       *versionResponse `json:"version,omitempty"`
}

// versionResponse exposes the placeholder schema, which is what a client needs
// in order to know what data to send when generating a document.
type versionResponse struct {
	ID           string    `json:"id"`
	Version      int       `json:"version"`
	Size         int64     `json:"size"`
	Placeholders []string  `json:"placeholders"`
	CreatedAt    time.Time `json:"created_at"`
}

func newTemplateResponse(t *domain.Template, v *domain.TemplateVersion) templateResponse {
	out := templateResponse{
		ID:            t.ID.String(),
		Name:          t.Name,
		Description:   t.Description,
		LatestVersion: t.LatestVersion,
		CreatedAt:     t.CreatedAt,
		UpdatedAt:     t.UpdatedAt,
	}
	if v != nil {
		out.Version = &versionResponse{
			ID:           v.ID.String(),
			Version:      v.Version,
			Size:         v.Size,
			Placeholders: v.Placeholders,
			CreatedAt:    v.CreatedAt,
		}
	}
	return out
}

// listResponse is the envelope every listing endpoint returns. Wrapping the
// array leaves room to add paging metadata without breaking clients.
type listResponse[T any] struct {
	Items []T `json:"items"`
}

func (s *Server) handleCreateTemplate(w http.ResponseWriter, r *http.Request) {
	file, err := s.openUpload(r)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	defer file.Close()

	result, err := s.templates.Create(r.Context(),
		userFrom(r.Context()).ID,
		r.FormValue("name"),
		r.FormValue("description"),
		file,
	)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, newTemplateResponse(result.Template, result.Version))
}

func (s *Server) handleAddTemplateVersion(w http.ResponseWriter, r *http.Request) {
	templateID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid template identifier")
		return
	}

	file, err := s.openUpload(r)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	defer file.Close()

	result, err := s.templates.AddVersion(r.Context(), userFrom(r.Context()).ID, templateID, file)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, newTemplateResponse(result.Template, result.Version))
}

func (s *Server) handleGetTemplate(w http.ResponseWriter, r *http.Request) {
	templateID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid template identifier")
		return
	}

	result, err := s.templates.Get(r.Context(), userFrom(r.Context()).ID, templateID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, newTemplateResponse(result.Template, result.Version))
}

func (s *Server) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	limit, offset := pagination(r)

	templates, err := s.templates.List(r.Context(), userFrom(r.Context()).ID, limit, offset)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	items := make([]templateResponse, 0, len(templates))
	for i := range templates {
		items = append(items, newTemplateResponse(&templates[i], nil))
	}
	writeJSON(w, s.logger, http.StatusOK, listResponse[templateResponse]{Items: items})
}

func (s *Server) handleDeleteTemplate(w http.ResponseWriter, r *http.Request) {
	templateID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid template identifier")
		return
	}

	if err := s.templates.Delete(r.Context(), userFrom(r.Context()).ID, templateID); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// openUpload pulls the DOCX out of a multipart request.
//
// Failures here are reported as validation errors rather than as internal
// ones: a malformed multipart body is the client's mistake, and saying which
// part is missing is far more useful than a bare 400.
func (s *Server) openUpload(r *http.Request) (multipart.File, error) {
	if err := requireContentType(r, "multipart/form-data"); err != nil {
		v := &domain.ValidationError{}
		v.Add("file", "must be sent as multipart/form-data")
		return nil, v
	}

	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		v := &domain.ValidationError{}
		v.Addf("file", "could not be read: %s", err)
		return nil, v
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		v := &domain.ValidationError{}
		v.Add("file", "is required")
		return nil, v
	}
	return file, nil
}
