package http

import (
	json "encoding/json/v2"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"docgen/internal/usecase"
)

// The data-subject rights of the LGPD, article 18: access and portability
// through the export, erasure through the delete.
//
// They are ordinary endpoints rather than a form a person fills in and waits
// on, because the service holds nothing that needs a human to decide. A right
// that resolves in one request is a right that gets exercised.

// exportResponse is the portable record handed to an account holder.
//
// Field names are snake_case like the rest of the API, and the shape is flat
// enough to read without this codebase in front of you — an export nobody can
// interpret satisfies the letter of the law and none of its point.
type exportResponse struct {
	ExportedAt time.Time         `json:"exported_at"`
	Account    userResponse      `json:"account"`
	Templates  []exportTemplate  `json:"templates"`
	Documents  []exportDocument  `json:"documents"`
	Batches    []exportBatch     `json:"batches"`
	Notes      map[string]string `json:"notes"`
}

type exportBatch struct {
	ID              string    `json:"id"`
	TemplateID      string    `json:"template_id"`
	TemplateVersion int       `json:"template_version"`
	Name            string    `json:"name"`
	CreatedAt       time.Time `json:"created_at"`
}

type exportTemplate struct {
	ID          string                  `json:"id"`
	Name        string                  `json:"name"`
	Description string                  `json:"description"`
	Deleted     bool                    `json:"deleted"`
	CreatedAt   time.Time               `json:"created_at"`
	UpdatedAt   time.Time               `json:"updated_at"`
	Versions    []exportTemplateVersion `json:"versions"`
}

type exportTemplateVersion struct {
	Version      int       `json:"version"`
	Size         int64     `json:"size"`
	Placeholders []string  `json:"placeholders"`
	CreatedAt    time.Time `json:"created_at"`
}

type exportDocument struct {
	ID              string `json:"id"`
	TemplateID      string `json:"template_id"`
	TemplateVersion int    `json:"template_version"`
	Filename        string `json:"filename"`
	Size            int64  `json:"size"`
	// Data is the substance of the export: the values that were filled in,
	// which for this product routinely describe someone other than the account
	// holder.
	Data      map[string]string `json:"data"`
	CreatedAt time.Time         `json:"created_at"`
	BatchID   *string           `json:"batch_id"`
}

func newExportResponse(e *usecase.AccountExport) exportResponse {
	templates := make([]exportTemplate, 0, len(e.Templates))
	for _, t := range e.Templates {
		versions := make([]exportTemplateVersion, 0, len(t.Versions))
		for _, v := range t.Versions {
			versions = append(versions, exportTemplateVersion{
				Version:      v.Version,
				Size:         v.Size,
				Placeholders: v.Placeholders,
				CreatedAt:    v.CreatedAt,
			})
		}
		templates = append(templates, exportTemplate{
			ID:          t.Template.ID.String(),
			Name:        t.Template.Name,
			Description: t.Template.Description,
			Deleted:     t.Deleted,
			CreatedAt:   t.Template.CreatedAt,
			UpdatedAt:   t.Template.UpdatedAt,
			Versions:    versions,
		})
	}

	documents := make([]exportDocument, 0, len(e.Documents))
	for i := range e.Documents {
		d := &e.Documents[i]
		documents = append(documents, exportDocument{
			ID:              d.ID.String(),
			TemplateID:      d.TemplateID.String(),
			TemplateVersion: d.TemplateVersion,
			Filename:        d.Filename,
			Size:            d.Size,
			Data:            d.Data,
			CreatedAt:       d.CreatedAt,
			BatchID:         newDocumentResponse(d).BatchID,
		})
	}

	batches := make([]exportBatch, 0, len(e.Batches))
	for _, b := range e.Batches {
		batches = append(batches, exportBatch{
			ID:              b.ID.String(),
			TemplateID:      b.TemplateID.String(),
			TemplateVersion: b.TemplateVersion,
			Name:            b.Name,
			CreatedAt:       b.CreatedAt,
		})
	}

	return exportResponse{
		ExportedAt: e.ExportedAt,
		Account:    newUserResponse(e.User),
		Templates:  templates,
		Documents:  documents,
		Batches:    batches,
		// Stated in the export itself so a reader knows what it does not
		// contain, rather than assuming it is everything.
		Notes: map[string]string{
			"arquivos": "Os arquivos .docx enviados e gerados não estão neste " +
				"JSON. Baixe cada um pelos endpoints de download.",
			"senha": "A senha não é exportável: guardamos apenas um hash " +
				"argon2id, que não permite recuperar o valor original.",
			"modelos_excluidos": "Modelos marcados como excluídos continuam " +
				"listados aqui porque ainda estão armazenados.",
		},
	}
}

// handleExportAccount answers with everything held about the caller.
func (s *Server) handleExportAccount(w http.ResponseWriter, r *http.Request) {
	export, err := s.privacy.Export(r.Context(), userFrom(r.Context()).ID, time.Now())
	if err != nil {
		writeError(w, s.logger, err)
		return
	}

	body, err := json.Marshal(newExportResponse(export))
	if err != nil {
		writeError(w, s.logger, fmt.Errorf("encode export: %w", err))
		return
	}

	// Offered as a file rather than rendered in a browser tab: this payload is
	// the account holder's own data, and it is meant to be kept.
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+export.Filename()+`"`)
	// It describes one account at one instant, and it holds personal data.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)

	if _, err := w.Write(body); err != nil {
		s.logger.Error("writing export failed", slog.Any("error", err))
	}
}

// handleDeleteAccount erases the caller's account and everything it owns.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	if err := s.privacy.DeleteAccount(r.Context(), userFrom(r.Context()).ID); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteDocument erases one generated document.
func (s *Server) handleDeleteDocument(w http.ResponseWriter, r *http.Request) {
	documentID, ok := pathID(r, "id")
	if !ok {
		writeFailure(w, s.logger, http.StatusBadRequest, codeBadRequest, "invalid document identifier")
		return
	}

	if err := s.documents.Delete(r.Context(), userFrom(r.Context()).ID, documentID); err != nil {
		writeError(w, s.logger, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
