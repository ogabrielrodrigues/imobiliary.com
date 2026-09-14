package usecase

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
	"unicode"
	"uuid"

	"docgen/internal/adapter/docx"
	"docgen/internal/domain"
)

// renderBuffers recycles the buffers a render writes into. Generation is the
// hot path, and a rendered document is large enough that handing every request
// a fresh buffer would keep the garbage collector busy for no reason.
var renderBuffers = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

// maxPooledBuffer caps the size of a buffer worth keeping. Returning an
// unusually large one to the pool would pin that memory for the process's
// lifetime.
const maxPooledBuffer = 4 << 20

// Documents implements document generation and retrieval.
type Documents struct {
	templates TemplateRepository
	documents DocumentRepository
	batches   BatchRepository
	blobs     BlobStore
	cache     *TemplateCache
	now       Clock
}

// DocumentsConfig collects the dependencies of the Documents use case.
type DocumentsConfig struct {
	Templates TemplateRepository
	Documents DocumentRepository
	// Batches is consulted only when a generation names a batch.
	Batches BatchRepository
	Blobs   BlobStore
	Cache   *TemplateCache
	Now     Clock
}

// NewDocuments wires the Documents use case.
func NewDocuments(cfg DocumentsConfig) *Documents {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Documents{
		templates: cfg.Templates,
		documents: cfg.Documents,
		batches:   cfg.Batches,
		blobs:     cfg.Blobs,
		cache:     cfg.Cache,
		now:       cfg.Now,
	}
}

// GenerateRequest describes one generation.
type GenerateRequest struct {
	OwnerID    uuid.UUID
	TemplateID uuid.UUID
	// Version pins a specific template version. When nil the latest is used,
	// or the batch's version when BatchID is set.
	Version  *int
	Filename string
	Data     map[string]string
	// BatchID joins the document to a batch of the same account, template and
	// version.
	BatchID *uuid.UUID
}

// Generate renders a document and stores it.
func (s *Documents) Generate(ctx context.Context, req GenerateRequest) (*domain.Document, error) {
	if req.BatchID != nil {
		pinned, err := s.batchVersion(ctx, req)
		if err != nil {
			return nil, err
		}
		req.Version = &pinned
	}

	version, err := resolveVersion(ctx, s.templates, req.OwnerID, req.TemplateID, req.Version)
	if err != nil {
		return nil, err
	}

	// Validating against the version's own schema is what turns a misspelled
	// key into an immediate, itemised 422 instead of a document missing text
	// the caller believed it had supplied.
	if err := domain.ValidateDocumentData(version.Placeholders, req.Data); err != nil {
		return nil, err
	}

	template, err := s.compiledTemplate(version)
	if err != nil {
		return nil, err
	}

	buf := renderBuffers.Get().(*bytes.Buffer)
	buf.Reset()
	defer func() {
		if buf.Cap() <= maxPooledBuffer {
			renderBuffers.Put(buf)
		}
	}()

	if err := template.Render(buf, req.Data); err != nil {
		return nil, err
	}

	hash, size, err := s.blobs.Put(bytes.NewReader(buf.Bytes()))
	if err != nil {
		return nil, err
	}

	doc := &domain.Document{
		ID:                uuid.NewV7(),
		OwnerID:           req.OwnerID,
		TemplateID:        version.TemplateID,
		TemplateVersionID: version.ID,
		TemplateVersion:   version.Version,
		Filename:          sanitizeFilename(req.Filename),
		BlobHash:          hash,
		Size:              size,
		Data:              req.Data,
		CreatedAt:         s.now().UTC(),
		BatchID:           req.BatchID,
	}
	if err := s.documents.Create(ctx, doc); err != nil {
		return nil, err
	}
	return doc, nil
}

// Get returns a document's metadata.
func (s *Documents) Get(ctx context.Context, ownerID, id uuid.UUID) (*domain.Document, error) {
	return s.documents.ByID(ctx, ownerID, id)
}

// List returns a page of the caller's documents, optionally narrowed to a
// template or a batch.
func (s *Documents) List(ctx context.Context, ownerID uuid.UUID, filter domain.DocumentFilter, limit, offset int) ([]domain.Document, error) {
	return s.documents.List(ctx, ownerID, filter, limit, offset)
}

// batchVersion checks that a generation may join the batch it names, and
// returns the template version the batch was created for.
//
// A batch describes its documents, so every one of them must come from the
// batch's own template and version. A batch of another account is reported as
// not existing, the same answer an unknown identifier gets.
func (s *Documents) batchVersion(ctx context.Context, req GenerateRequest) (int, error) {
	invalid := func(format string, args ...any) error {
		v := &domain.ValidationError{}
		v.Addf("batch_id", format, args...)
		return v
	}

	if s.batches == nil {
		return 0, invalid("batches are not available")
	}
	batch, err := s.batches.ByID(ctx, req.OwnerID, *req.BatchID)
	if errors.Is(err, domain.ErrNotFound) {
		return 0, invalid("does not exist")
	}
	if err != nil {
		return 0, err
	}
	if batch.TemplateID != req.TemplateID {
		return 0, invalid("belongs to another template")
	}
	if req.Version != nil && *req.Version != batch.TemplateVersion {
		return 0, invalid("was created for version %d of this template", batch.TemplateVersion)
	}
	return batch.TemplateVersion, nil
}

// Open returns a document together with a readable handle on its bytes. The
// caller closes the handle.
func (s *Documents) Open(ctx context.Context, ownerID, id uuid.UUID) (*domain.Document, io.ReadSeekCloser, error) {
	doc, err := s.documents.ByID(ctx, ownerID, id)
	if err != nil {
		return nil, nil, err
	}

	content, err := s.blobs.Open(doc.BlobHash)
	if err != nil {
		return nil, nil, err
	}
	return doc, content, nil
}

// Delete erases one generated document, and the stored file with it when no
// other row refers to those bytes.
//
// A real delete, not a flag: the values a user typed live in this row, and a
// document they asked to remove has to actually go.
func (s *Documents) Delete(ctx context.Context, ownerID, id uuid.UUID) error {
	orphaned, err := s.documents.Delete(ctx, ownerID, id)
	if err != nil {
		return err
	}
	// Empty means deduplication left the bytes as the body of another
	// document, possibly one belonging to a different account.
	if orphaned == "" {
		return nil
	}
	if err := s.blobs.Delete(orphaned); err != nil {
		return fmt.Errorf("delete document body: %w", err)
	}
	return nil
}

// resolveVersion picks the template version a request refers to: the pinned
// one, or the latest when version is nil.
func resolveVersion(ctx context.Context, templates TemplateRepository, ownerID, templateID uuid.UUID, version *int) (*domain.TemplateVersion, error) {
	if version == nil {
		return templates.LatestVersion(ctx, ownerID, templateID)
	}
	return templates.Version(ctx, ownerID, templateID, *version)
}

// compiledTemplate returns the parsed template for a version, compiling and
// caching it on a miss.
func (s *Documents) compiledTemplate(version *domain.TemplateVersion) (*docx.Template, error) {
	if cached, ok := s.cache.Get(version.ID); ok {
		return cached, nil
	}

	raw, err := s.blobs.ReadAll(version.BlobHash)
	if err != nil {
		return nil, fmt.Errorf("load template version %s: %w", version.ID, err)
	}
	compiled, err := docx.Compile(raw)
	if err != nil {
		return nil, err
	}

	s.cache.Put(version.ID, compiled)
	return compiled, nil
}

// defaultFilename is used when the caller supplies nothing usable.
const defaultFilename = "document.docx"

// sanitizeFilename reduces a caller-supplied name to something safe to echo in
// a Content-Disposition header.
//
// The name never touches the filesystem — documents are stored under their
// content hash — so this guards the HTTP response rather than the disk: a
// header value carrying a quote or a newline could otherwise be used to inject
// headers of the attacker's choosing.
func sanitizeFilename(name string) string {
	return sanitizeName(name, ".docx", defaultFilename)
}

// sanitizeName applies the filename rules with any extension: letters, digits,
// space, ".", "-" and "_" are kept, anything else becomes "_", the name is cut
// at 100 bytes, and the extension is added when missing.
func sanitizeName(name, extension, fallback string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return fallback
	}

	var b strings.Builder
	for _, r := range name {
		switch {
		case r == '.' || r == '-' || r == '_' || r == ' ':
			b.WriteRune(r)
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
		if b.Len() >= 100 {
			break
		}
	}

	cleaned := strings.TrimSpace(b.String())
	if cleaned == "" || cleaned == "." || cleaned == ".." {
		return fallback
	}
	if !strings.HasSuffix(strings.ToLower(cleaned), extension) {
		cleaned += extension
	}
	return cleaned
}
