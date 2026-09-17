package http

import (
	"net/http"
	"time"
	"uuid"

	"docgen/internal/domain"
	"docgen/internal/usecase"
)

// docxMediaType is the OOXML word processing media type.
const docxMediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

// generateRequest is the body of POST /v1/documents.
type generateRequest struct {
	TemplateID string `json:"template_id"`
	// Version pins a template version. When omitted the latest is used, which
	// is the common case; pinning matters when a caller must keep producing
	// documents against a version it has already validated against.
	Version  *int              `json:"version,omitempty"`
	Filename string            `json:"filename,omitempty"`
	Data     map[string]string `json:"data"`
	// BatchID joins the document to a batch created with POST /v1/batches, of
	// the same template. The batch's version is used.
	BatchID string `json:"batch_id,omitempty"`
	// Reference ties the document to a record elsewhere, such as
	// "contract:<id>", for listing with ?reference=.
	Reference string `json:"reference,omitempty"`
}

// documentResponse presents a generated document. The download URL is included
// so a client never has to assemble a path by hand.
type documentResponse struct {
	ID              string            `json:"id"`
	TemplateID      string            `json:"template_id"`
	TemplateVersion int               `json:"template_version"`
	Filename        string            `json:"filename"`
	Size            int64             `json:"size"`
	Data            map[string]string `json:"data"`
	CreatedAt       time.Time         `json:"created_at"`
	DownloadURL     string            `json:"download_url"`
	// BatchID is null for a document generated on its own.
	BatchID   *string `json:"batch_id"`
	Reference string  `json:"reference"`
}

func newDocumentResponse(d *domain.Document) documentResponse {
	var batchID *string
	if d.BatchID != nil {
		id := d.BatchID.String()
		batchID = &id
	}
	return documentResponse{
		ID:              d.ID.String(),
		TemplateID:      d.TemplateID.String(),
		TemplateVersion: d.TemplateVersion,
		Filename:        d.Filename,
		Size:            d.Size,
		Data:            d.Data,
		CreatedAt:       d.CreatedAt,
		DownloadURL:     "/v1/documents/" + d.ID.String() + "/download",
		BatchID:         batchID,
		Reference:       d.Reference,
	}
}

func (s *Server) handleGenerateDocument(w http.ResponseWriter, r *http.Request) {
	if err := requireContentType(r, "application/json"); err != nil {
		writeFailure(w, s.logger, http.StatusUnsupportedMediaType, codeUnsupportedTyp, err.Error())
		return
	}

	var body generateRequest
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, s.logger, err)
		return
	}

	templateID, err := uuid.Parse(body.TemplateID)
	if err != nil {
		v := &domain.ValidationError{}
		v.Add("template_id", "must be a valid identifier")
		writeError(w, s.logger, v)
		return
	}

	var batchID *uuid.UUID
	if body.BatchID != "" {
		id, err := uuid.Parse(body.BatchID)
		if err != nil {
			v := &domain.ValidationError{}
			v.Add("batch_id", "must be a valid identifier")
			writeError(w, s.logger, v)
			return
		}
		batchID = &id
	}

	doc, err := s.documents.Generate(r.Context(), usecase.GenerateRequest{
		OwnerID:    callerFrom(r.Context()).OwnerID,
		TemplateID: templateID,
		Version:    body.Version,
		Filename:   body.Filename,
		Data:       body.Data,
		BatchID:    batchID,
		Reference:  body.Reference,
	})
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, newDocumentResponse(doc))
}

func (s *Server) handleGetDocument(w http.ResponseWriter, r *http.Request) {
	documentID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid document identifier")
		return
	}

	doc, err := s.documents.Get(r.Context(), callerFrom(r.Context()).OwnerID, documentID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, newDocumentResponse(doc))
}

func (s *Server) handleListDocuments(w http.ResponseWriter, r *http.Request) {
	var filter domain.DocumentFilter
	var err error
	if filter.TemplateID, err = queryID(r, "template_id"); err != nil {
		writeError(w, s.logger, err)
		return
	}
	if filter.BatchID, err = queryID(r, "batch_id"); err != nil {
		writeError(w, s.logger, err)
		return
	}
	filter.Reference = r.URL.Query().Get("reference")
	switch r.URL.Query().Get("order") {
	case "", "newest":
	case "oldest":
		filter.OldestFirst = true
	default:
		v := &domain.ValidationError{}
		v.Add("order", "must be newest or oldest")
		writeError(w, s.logger, v)
		return
	}

	limit, offset := pagination(r)
	docs, err := s.documents.List(r.Context(), callerFrom(r.Context()).OwnerID, filter, limit, offset)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	items := make([]documentResponse, 0, len(docs))
	for i := range docs {
		items = append(items, newDocumentResponse(&docs[i]))
	}
	writeJSON(w, s.logger, http.StatusOK, listResponse[documentResponse]{Items: items})
}

// handleDownloadDocument streams the stored DOCX.
//
// http.ServeContent is used rather than a plain io.Copy because it handles
// range requests, conditional requests and the Content-Length header, which a
// download endpoint would otherwise have to reimplement.
func (s *Server) handleDownloadDocument(w http.ResponseWriter, r *http.Request) {
	documentID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid document identifier")
		return
	}

	doc, content, err := s.documents.Open(r.Context(), callerFrom(r.Context()).OwnerID, documentID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	defer content.Close()

	w.Header().Set("Content-Type", docxMediaType)
	// The filename was sanitised when the document was created, so it holds no
	// character that could break out of the quoted header value.
	w.Header().Set("Content-Disposition", `attachment; filename="`+doc.Filename+`"`)
	// Documents are immutable once generated, so a client may cache one
	// indefinitely; the identifier changes whenever the content does.
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")

	http.ServeContent(w, r, doc.Filename, doc.CreatedAt, content)
}
