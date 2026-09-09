package usecase

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"time"
	"uuid"

	"docgen/internal/adapter/docx"
	"docgen/internal/domain"
)

// Templates implements the template lifecycle: upload, versioning, listing and
// removal.
type Templates struct {
	repo      TemplateRepository
	blobs     BlobStore
	cache     *TemplateCache
	maxUpload int64
	now       Clock
}

// TemplatesConfig collects the dependencies of the Templates use case.
type TemplatesConfig struct {
	Repo      TemplateRepository
	Blobs     BlobStore
	Cache     *TemplateCache
	MaxUpload int64
	Now       Clock
}

// NewTemplates wires the Templates use case.
func NewTemplates(cfg TemplatesConfig) *Templates {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Templates{
		repo:      cfg.Repo,
		blobs:     cfg.Blobs,
		cache:     cfg.Cache,
		maxUpload: cfg.MaxUpload,
		now:       cfg.Now,
	}
}

// TemplateWithVersion pairs a template with one of its versions, which is what
// the API returns after an upload.
type TemplateWithVersion struct {
	Template *domain.Template
	Version  *domain.TemplateVersion
}

// Create stores a new template from an uploaded DOCX.
func (s *Templates) Create(ctx context.Context, ownerID uuid.UUID, name, description string, upload io.Reader) (*TemplateWithVersion, error) {
	if err := domain.ValidateTemplateMetadata(name, description); err != nil {
		return nil, err
	}

	prepared, err := s.prepare(upload)
	if err != nil {
		return nil, err
	}

	now := s.now().UTC()
	tmpl := &domain.Template{
		ID:            uuid.NewV7(),
		OwnerID:       ownerID,
		Name:          name,
		Description:   description,
		LatestVersion: 1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	version := &domain.TemplateVersion{
		ID:           uuid.NewV7(),
		TemplateID:   tmpl.ID,
		Version:      1,
		BlobHash:     prepared.hash,
		Size:         prepared.size,
		Placeholders: prepared.placeholders,
		CreatedAt:    now,
	}

	if err := s.repo.Create(ctx, tmpl, version); err != nil {
		return nil, err
	}
	s.cache.Put(version.ID, prepared.compiled)

	return &TemplateWithVersion{Template: tmpl, Version: version}, nil
}

// AddVersion publishes a new version of an existing template. Earlier versions
// stay available, so documents generated from them remain reproducible.
func (s *Templates) AddVersion(ctx context.Context, ownerID, templateID uuid.UUID, upload io.Reader) (*TemplateWithVersion, error) {
	tmpl, err := s.repo.ByID(ctx, ownerID, templateID)
	if err != nil {
		return nil, err
	}

	prepared, err := s.prepare(upload)
	if err != nil {
		return nil, err
	}

	version := &domain.TemplateVersion{
		ID:           uuid.NewV7(),
		TemplateID:   tmpl.ID,
		BlobHash:     prepared.hash,
		Size:         prepared.size,
		Placeholders: prepared.placeholders,
		CreatedAt:    s.now().UTC(),
	}
	if err := s.repo.AddVersion(ctx, ownerID, version); err != nil {
		return nil, err
	}

	tmpl.LatestVersion = version.Version
	tmpl.UpdatedAt = version.CreatedAt
	s.cache.Put(version.ID, prepared.compiled)

	return &TemplateWithVersion{Template: tmpl, Version: version}, nil
}

// Get returns a template together with its latest version, whose placeholder
// list is the schema a caller must satisfy to generate a document.
func (s *Templates) Get(ctx context.Context, ownerID, templateID uuid.UUID) (*TemplateWithVersion, error) {
	tmpl, err := s.repo.ByID(ctx, ownerID, templateID)
	if err != nil {
		return nil, err
	}

	version, err := s.repo.LatestVersion(ctx, ownerID, templateID)
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		return nil, err
	}
	return &TemplateWithVersion{Template: tmpl, Version: version}, nil
}

// List returns a page of the caller's templates.
func (s *Templates) List(ctx context.Context, ownerID uuid.UUID, limit, offset int) ([]domain.Template, error) {
	return s.repo.List(ctx, ownerID, limit, offset)
}

// Delete hides a template from the caller.
func (s *Templates) Delete(ctx context.Context, ownerID, templateID uuid.UUID) error {
	return s.repo.SoftDelete(ctx, ownerID, templateID, s.now().UTC())
}

// TemplateFile is a stored template version together with a readable handle on
// the archive itself.
type TemplateFile struct {
	Template *domain.Template
	Version  *domain.TemplateVersion
	Filename string
	Content  io.ReadSeekCloser
}

// OpenVersion returns the stored .docx of one template version. Pass a nil
// version to get the latest.
//
// Reading the archive back is what lets a client show the template's content
// rather than only its metadata, and what lets a template authored in an editor
// be reopened: the editor's own source travels inside the archive as an extra
// part, which this service copies through untouched.
//
// The caller closes Content.
func (s *Templates) OpenVersion(ctx context.Context, ownerID, templateID uuid.UUID, version *int) (*TemplateFile, error) {
	tmpl, err := s.repo.ByID(ctx, ownerID, templateID)
	if err != nil {
		return nil, err
	}

	stored, err := s.resolveVersion(ctx, ownerID, templateID, version)
	if err != nil {
		return nil, err
	}

	content, err := s.blobs.Open(stored.BlobHash)
	if err != nil {
		return nil, fmt.Errorf("open template version %s: %w", stored.ID, err)
	}

	return &TemplateFile{
		Template: tmpl,
		Version:  stored,
		Filename: sanitizeFilename(fmt.Sprintf("%s-v%d", tmpl.Name, stored.Version)),
		Content:  content,
	}, nil
}

// resolveVersion picks the version a request refers to, defaulting to the
// latest.
func (s *Templates) resolveVersion(ctx context.Context, ownerID, templateID uuid.UUID, version *int) (*domain.TemplateVersion, error) {
	if version == nil {
		return s.repo.LatestVersion(ctx, ownerID, templateID)
	}
	return s.repo.Version(ctx, ownerID, templateID, *version)
}

// preparedTemplate is the result of validating and storing an upload.
type preparedTemplate struct {
	hash         string
	size         int64
	placeholders []string
	compiled     *docx.Template
}

// prepare reads an upload, normalizes it, compiles it and stores the result.
//
// Normalization happens once, here, rather than on every generation: the stored
// archive already has each placeholder gathered into a single run, so rendering
// never has to parse XML again.
func (s *Templates) prepare(upload io.Reader) (*preparedTemplate, error) {
	// One byte past the limit tells "at the limit" apart from "over" it.
	raw, err := io.ReadAll(io.LimitReader(upload, s.maxUpload+1))
	if err != nil {
		return nil, fmt.Errorf("read uploaded template: %w", err)
	}
	if int64(len(raw)) > s.maxUpload {
		v := &domain.ValidationError{}
		v.Addf("file", "must be at most %d bytes", s.maxUpload)
		return nil, v
	}
	if len(raw) == 0 {
		v := &domain.ValidationError{}
		v.Add("file", "is required")
		return nil, v
	}

	normalized, err := docx.Normalize(raw)
	if err != nil {
		return nil, err
	}
	compiled, err := docx.Compile(normalized)
	if err != nil {
		return nil, err
	}

	hash, size, err := s.blobs.Put(bytes.NewReader(normalized))
	if err != nil {
		return nil, err
	}

	return &preparedTemplate{
		hash:         hash,
		size:         size,
		placeholders: compiled.Placeholders(),
		compiled:     compiled,
	}, nil
}
