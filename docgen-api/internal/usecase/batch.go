package usecase

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
	"time"
	"uuid"

	"docgen/internal/domain"
)

// Batches implements batches: documents generated together from one template
// version, shown as one entry in the history and downloaded as one archive.
//
// Generating the documents of a batch is not done here. The caller creates the
// batch, then generates each document through Documents naming it, one request
// per document: generation stays synchronous and each row succeeds or fails
// on its own.
type Batches struct {
	templates TemplateRepository
	batches   BatchRepository
	documents DocumentRepository
	blobs     BlobStore
	now       Clock
}

// BatchesConfig collects the dependencies of the Batches use case.
type BatchesConfig struct {
	Templates TemplateRepository
	Batches   BatchRepository
	Documents DocumentRepository
	Blobs     BlobStore
	Now       Clock
}

// NewBatches wires the Batches use case.
func NewBatches(cfg BatchesConfig) *Batches {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Batches{
		templates: cfg.Templates,
		batches:   cfg.Batches,
		documents: cfg.Documents,
		blobs:     cfg.Blobs,
		now:       cfg.Now,
	}
}

// CreateBatchRequest describes a new batch.
type CreateBatchRequest struct {
	OwnerID    uuid.UUID
	TemplateID uuid.UUID
	// Version pins the template version. When nil the latest is used, and every
	// document of the batch is then generated from that one.
	Version *int
	Name    string
}

// Create records an empty batch, ready for documents to join it.
func (s *Batches) Create(ctx context.Context, req CreateBatchRequest) (*domain.BatchSummary, error) {
	if err := domain.ValidateBatchName(req.Name); err != nil {
		return nil, err
	}

	version, err := resolveVersion(ctx, s.templates, req.OwnerID, req.TemplateID, req.Version)
	if err != nil {
		return nil, err
	}

	batch := domain.Batch{
		ID:                uuid.NewV7(),
		OwnerID:           req.OwnerID,
		TemplateID:        version.TemplateID,
		TemplateVersionID: version.ID,
		TemplateVersion:   version.Version,
		Name:              strings.TrimSpace(req.Name),
		CreatedAt:         s.now().UTC(),
	}
	if err := s.batches.Create(ctx, &batch); err != nil {
		return nil, err
	}
	return &domain.BatchSummary{Batch: batch}, nil
}

// Get returns a batch and what it holds.
func (s *Batches) Get(ctx context.Context, ownerID, id uuid.UUID) (*domain.BatchSummary, error) {
	return s.batches.ByID(ctx, ownerID, id)
}

// History returns a page of the account's generation history.
func (s *Batches) History(ctx context.Context, ownerID uuid.UUID, templateID *uuid.UUID, limit, offset int) ([]domain.HistoryEntry, error) {
	return s.batches.History(ctx, ownerID, templateID, limit, offset)
}

// Delete erases a batch, its documents, and the stored files nothing else
// refers to.
func (s *Batches) Delete(ctx context.Context, ownerID, id uuid.UUID) error {
	orphaned, err := s.batches.Delete(ctx, ownerID, id)
	if err != nil {
		return err
	}
	for _, hash := range orphaned {
		if err := s.blobs.Delete(hash); err != nil {
			return fmt.Errorf("delete batch document body: %w", err)
		}
	}
	return nil
}

// archivePageSize is how many documents are read per query while archiving.
const archivePageSize = 100

// WriteArchive writes a ZIP holding every document of a batch to w, oldest
// first, which is the order they were generated in.
//
// Entries are stored rather than deflated: a .docx is already a deflated
// archive, and compressing it again costs time for nothing.
func (s *Batches) WriteArchive(ctx context.Context, ownerID, id uuid.UUID, w io.Writer) error {
	batchID := id
	var documents []domain.Document
	for offset := 0; ; offset += archivePageSize {
		page, err := s.documents.List(ctx, ownerID, domain.DocumentFilter{BatchID: &batchID, OldestFirst: true}, archivePageSize, offset)
		if err != nil {
			return err
		}
		documents = append(documents, page...)
		if len(page) < archivePageSize {
			break
		}
	}

	names := make([]string, len(documents))
	for i := range documents {
		names[i] = documents[i].Filename
	}
	names = archiveNames(names)

	archive := zip.NewWriter(w)
	for i := range documents {
		doc := &documents[i]
		entry, err := archive.CreateHeader(&zip.FileHeader{
			Name:     names[i],
			Method:   zip.Store,
			Modified: doc.CreatedAt,
		})
		if err != nil {
			return fmt.Errorf("archive batch: %w", err)
		}

		content, err := s.blobs.Open(doc.BlobHash)
		if err != nil {
			return fmt.Errorf("archive batch: %w", err)
		}
		_, err = io.Copy(entry, content)
		content.Close()
		if err != nil {
			return fmt.Errorf("archive batch: %w", err)
		}
	}
	if err := archive.Close(); err != nil {
		return fmt.Errorf("archive batch: %w", err)
	}
	return nil
}

// ArchiveFilename is the name a batch's archive is downloaded as.
func ArchiveFilename(batch *domain.BatchSummary) string {
	return sanitizeName(batch.Name, ".zip", "lote.zip")
}

// archiveNames makes filenames unique within one archive, in order: the second
// "contrato.docx" becomes "contrato (2).docx". Documents are not required to
// have distinct names, but entries of one archive must, or extracting it
// silently overwrites all but the last.
func archiveNames(filenames []string) []string {
	taken := make(map[string]bool, len(filenames))
	out := make([]string, len(filenames))

	for i, name := range filenames {
		ext := path.Ext(name)
		base := strings.TrimSuffix(name, ext)

		candidate := name
		for n := 2; taken[strings.ToLower(candidate)]; n++ {
			candidate = base + " (" + strconv.Itoa(n) + ")" + ext
		}
		taken[strings.ToLower(candidate)] = true
		out[i] = candidate
	}
	return out
}
