package usecase

import (
	"slices"
	"testing"
	"time"

	"docgen/internal/domain"
)

func TestArchiveNamesMakeEntriesUnique(t *testing.T) {
	got := archiveNames([]string{
		"Contrato - Ana.docx",
		"Contrato - Ana.docx",
		"contrato - ana.docx",
		"Recibo.docx",
		"Contrato - Ana (2).docx",
	})
	want := []string{
		"Contrato - Ana.docx",
		"Contrato - Ana (2).docx",
		// Case differs, but on Windows and macOS extracting it would still
		// overwrite the first.
		"contrato - ana (3).docx",
		"Recibo.docx",
		// Already taken by the renaming above, so it moves on.
		"Contrato - Ana (2) (2).docx",
	}
	if !slices.Equal(got, want) {
		t.Errorf("archiveNames() = %q, want %q", got, want)
	}
}

func TestArchiveFilename(t *testing.T) {
	tests := []struct{ name, want string }{
		{"Aditamentos de setembro", "Aditamentos de setembro.zip"},
		{"Lote 12/09", "Lote 12_09.zip"},
		{"   ", "lote.zip"},
	}
	for _, tc := range tests {
		batch := &domain.BatchSummary{Batch: domain.Batch{Name: tc.name, CreatedAt: time.Now()}}
		if got := ArchiveFilename(batch); got != tc.want {
			t.Errorf("ArchiveFilename(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}
