package http

import (
	"mime/multipart"
	"net/http"
	"strconv"
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
		version := newVersionResponse(v)
		out.Version = &version
	}
	return out
}

func newVersionResponse(v *domain.TemplateVersion) versionResponse {
	return versionResponse{
		ID:           v.ID.String(),
		Version:      v.Version,
		Size:         v.Size,
		Placeholders: v.Placeholders,
		CreatedAt:    v.CreatedAt,
	}
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
		callerFrom(r.Context()).OwnerID,
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

	result, err := s.templates.AddVersion(r.Context(), callerFrom(r.Context()).OwnerID, templateID, file)
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

	result, err := s.templates.Get(r.Context(), callerFrom(r.Context()).OwnerID, templateID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, newTemplateResponse(result.Template, result.Version))
}

func (s *Server) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	limit, offset := pagination(r)

	templates, err := s.templates.List(r.Context(), callerFrom(r.Context()).OwnerID, limit, offset)
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

// handleListTemplateVersions lists the versions of one template, newest first.
//
// Version numbers are contiguous, so a client could guess them, but not their
// placeholder schema or size — which is what it needs in order to offer a
// choice of version rather than only the latest.
func (s *Server) handleListTemplateVersions(w http.ResponseWriter, r *http.Request) {
	templateID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid template identifier")
		return
	}
	limit, offset := pagination(r)

	versions, err := s.templates.ListVersions(r.Context(), callerFrom(r.Context()).OwnerID, templateID, limit, offset)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	items := make([]versionResponse, 0, len(versions))
	for i := range versions {
		items = append(items, newVersionResponse(&versions[i]))
	}
	writeJSON(w, s.logger, http.StatusOK, listResponse[versionResponse]{Items: items})
}

func (s *Server) handleDeleteTemplate(w http.ResponseWriter, r *http.Request) {
	templateID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid template identifier")
		return
	}

	if err := s.templates.Delete(r.Context(), callerFrom(r.Context()).OwnerID, templateID); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDownloadTemplateVersion streams the stored .docx of one version.
//
// It exists so a client can work with the template's content, not just its
// metadata: rendering a preview, or reopening a template that was authored in
// an editor, whose source travels inside the archive as an extra part.
func (s *Server) handleDownloadTemplateVersion(w http.ResponseWriter, r *http.Request) {
	templateID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid template identifier")
		return
	}

	version, ok := pathVersion(r, "version")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid version number")
		return
	}

	file, err := s.templates.OpenVersion(r.Context(), callerFrom(r.Context()).OwnerID, templateID, &version)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	defer file.Content.Close()

	w.Header().Set("Content-Type", docxMediaType)
	// The name is built from the template's own name and passed through the
	// same sanitiser as a generated document, so it cannot break out of the
	// quoted header value.
	w.Header().Set("Content-Disposition", `attachment; filename="`+file.Filename+`"`)
	// A published version is immutable, so it can be cached indefinitely.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")

	http.ServeContent(w, r, file.Filename, file.Version.CreatedAt, file.Content)
}

// pathVersion reads a positive version number from a path wildcard.
func pathVersion(r *http.Request, name string) (int, bool) {
	version, err := strconv.Atoi(r.PathValue(name))
	if err != nil || version < 1 {
		return 0, false
	}
	return version, true
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
