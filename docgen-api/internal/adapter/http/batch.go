package http

import (
	"net/http"
	"time"
	"uuid"

	"docgen/internal/domain"
	"docgen/internal/usecase"
)

// createBatchRequest is the body of POST /v1/batches.
type createBatchRequest struct {
	TemplateID string `json:"template_id"`
	// Version pins the template version every document of the batch will be
	// generated from. When omitted, the latest at creation is used.
	Version *int   `json:"version,omitempty"`
	Name    string `json:"name"`
}

// batchResponse presents a batch and what it holds.
type batchResponse struct {
	ID              string    `json:"id"`
	TemplateID      string    `json:"template_id"`
	TemplateVersion int       `json:"template_version"`
	Name            string    `json:"name"`
	Documents       int       `json:"documents"`
	Size            int64     `json:"size"`
	CreatedAt       time.Time `json:"created_at"`
	DownloadURL     string    `json:"download_url"`
}

func newBatchResponse(b *domain.BatchSummary) batchResponse {
	return batchResponse{
		ID:              b.ID.String(),
		TemplateID:      b.TemplateID.String(),
		TemplateVersion: b.TemplateVersion,
		Name:            b.Name,
		Documents:       b.Documents,
		Size:            b.Size,
		CreatedAt:       b.CreatedAt,
		DownloadURL:     "/v1/batches/" + b.ID.String() + "/download",
	}
}

// historyItem is one entry of GET /v1/history: a document generated on its
// own, or a batch. "kind" says which of the two fields is present.
type historyItem struct {
	Kind     string            `json:"kind"`
	Document *documentResponse `json:"document,omitempty"`
	Batch    *batchResponse    `json:"batch,omitempty"`
}

func (s *Server) handleCreateBatch(w http.ResponseWriter, r *http.Request) {
	if err := requireContentType(r, "application/json"); err != nil {
		writeFailure(w, s.logger, http.StatusUnsupportedMediaType, codeUnsupportedTyp, err.Error())
		return
	}

	var body createBatchRequest
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

	batch, err := s.batches.Create(r.Context(), usecase.CreateBatchRequest{
		OwnerID:    callerFrom(r.Context()).OwnerID,
		TemplateID: templateID,
		Version:    body.Version,
		Name:       body.Name,
	})
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusCreated, newBatchResponse(batch))
}

func (s *Server) handleGetBatch(w http.ResponseWriter, r *http.Request) {
	batchID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid batch identifier")
		return
	}

	batch, err := s.batches.Get(r.Context(), callerFrom(r.Context()).OwnerID, batchID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}
	writeJSON(w, s.logger, http.StatusOK, newBatchResponse(batch))
}

func (s *Server) handleDeleteBatch(w http.ResponseWriter, r *http.Request) {
	batchID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid batch identifier")
		return
	}

	if err := s.batches.Delete(r.Context(), callerFrom(r.Context()).OwnerID, batchID); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDownloadBatch streams a ZIP of every document in a batch.
//
// The batch is read first, so an unknown or foreign one is a 404 before any
// byte of the archive is written. After that the archive streams: a failure
// halfway through can only end the response, and the log records why.
func (s *Server) handleDownloadBatch(w http.ResponseWriter, r *http.Request) {
	batchID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid batch identifier")
		return
	}

	owner := callerFrom(r.Context()).OwnerID
	batch, err := s.batches.Get(r.Context(), owner, batchID)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	w.Header().Set("Content-Type", "application/zip")
	// The name is sanitised the way a document's is, so it holds no character
	// that could break out of the quoted header value.
	w.Header().Set("Content-Disposition", `attachment; filename="`+usecase.ArchiveFilename(batch)+`"`)
	// Unlike a document, a batch can still gain or lose documents.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	if err := s.batches.WriteArchive(r.Context(), owner, batchID, w); err != nil {
		s.logger.Error("batch archive failed mid-stream", "batch", batchID.String(), "error", err)
	}
}

// handleHistory lists documents generated on their own and batches, mixed,
// newest first, optionally narrowed to one template.
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	templateID, err := queryID(r, "template_id")
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	limit, offset := pagination(r)
	entries, err := s.batches.History(r.Context(), callerFrom(r.Context()).OwnerID, templateID, limit, offset)
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	items := make([]historyItem, 0, len(entries))
	for i := range entries {
		entry := &entries[i]
		if entry.Batch != nil {
			batch := newBatchResponse(entry.Batch)
			items = append(items, historyItem{Kind: "batch", Batch: &batch})
			continue
		}
		document := newDocumentResponse(entry.Document)
		items = append(items, historyItem{Kind: "document", Document: &document})
	}
	writeJSON(w, s.logger, http.StatusOK, listResponse[historyItem]{Items: items})
}

// queryID reads an optional identifier from the query string. Absent is nil;
// present but malformed is a validation error on that parameter.
func queryID(r *http.Request, name string) (*uuid.UUID, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return nil, nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		v := &domain.ValidationError{}
		v.Add(name, "must be a valid identifier")
		return nil, v
	}
	return &id, nil
}
