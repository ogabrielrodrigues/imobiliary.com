package usecase

import (
	"testing"
	"uuid"

	"docgen/internal/adapter/docx"
)

// stubTemplate stands in for a compiled template. The cache never looks inside
// one, so an empty value is enough to test identity and eviction.
func stubTemplate() *docx.Template {
	return &docx.Template{}
}

func TestTemplateCacheStoresAndReturns(t *testing.T) {
	cache := NewTemplateCache(4)
	id := uuid.NewV7()
	want := stubTemplate()

	if _, found := cache.Get(id); found {
		t.Error("an empty cache reported a hit")
	}

	cache.Put(id, want)
	got, found := cache.Get(id)
	if !found {
		t.Fatal("a stored template was not found")
	}
	if got != want {
		t.Error("the cache returned a different template than the one stored")
	}
}

func TestTemplateCacheEvictsLeastRecentlyUsed(t *testing.T) {
	cache := NewTemplateCache(2)
	first, second, third := uuid.NewV7(), uuid.NewV7(), uuid.NewV7()

	cache.Put(first, stubTemplate())
	cache.Put(second, stubTemplate())

	// Touching the first entry makes the second the least recently used.
	if _, found := cache.Get(first); !found {
		t.Fatal("the first entry was missing before eviction")
	}

	cache.Put(third, stubTemplate())

	if cache.Len() != 2 {
		t.Errorf("cache holds %d entries, want 2", cache.Len())
	}
	if _, found := cache.Get(first); !found {
		t.Error("the recently used entry was evicted")
	}
	if _, found := cache.Get(second); found {
		t.Error("the least recently used entry survived eviction")
	}
	if _, found := cache.Get(third); !found {
		t.Error("the newest entry is missing")
	}
}

func TestTemplateCacheReplacesExistingEntry(t *testing.T) {
	cache := NewTemplateCache(2)
	id := uuid.NewV7()

	cache.Put(id, stubTemplate())
	replacement := stubTemplate()
	cache.Put(id, replacement)

	if cache.Len() != 1 {
		t.Errorf("re-storing the same key produced %d entries, want 1", cache.Len())
	}
	if got, _ := cache.Get(id); got != replacement {
		t.Error("the cache kept the superseded template")
	}
}

func TestTemplateCacheRejectsNonPositiveCapacity(t *testing.T) {
	cache := NewTemplateCache(0)
	id := uuid.NewV7()

	cache.Put(id, stubTemplate())
	if _, found := cache.Get(id); !found {
		t.Error("a cache built with capacity 0 stores nothing at all")
	}
}

func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		name, in, want string
	}{
		{"empty falls back", "", defaultFilename},
		{"whitespace falls back", "   ", defaultFilename},
		{"extension is added", "contract", "contract.docx"},
		{"extension is kept", "contract.docx", "contract.docx"},
		{"extension case is tolerated", "contract.DOCX", "contract.DOCX"},
		{"spaces survive", "service agreement", "service agreement.docx"},
		// Dots are kept because they are legitimate in a filename; only the
		// separators are neutralised. The result never reaches the filesystem
		// anyway, since documents are stored under their content hash.
		{"path separators are removed", "../../etc/passwd", ".._.._etc_passwd.docx"},
		{"quotes are removed", `evil".docx`, "evil_.docx"},
		{"newlines are removed", "evil\r\nX-Injected: 1.docx", "evil__X-Injected_ 1.docx"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeFilename(tc.in); got != tc.want {
				t.Errorf("sanitizeFilename(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestSanitizeFilenameNeverLeavesHeaderBreakingCharacters is the property that
// actually matters: whatever the input, the result must be safe to place inside
// a quoted Content-Disposition value.
func TestSanitizeFilenameNeverLeavesHeaderBreakingCharacters(t *testing.T) {
	inputs := []string{
		`"; filename="evil.docx`,
		"line\nbreak",
		"carriage\rreturn",
		"null\x00byte",
		"back\\slash",
		"semi;colon",
		"unicode-ok-名前",
	}

	for _, in := range inputs {
		got := sanitizeFilename(in)
		for _, forbidden := range []rune{'"', '\n', '\r', 0, '\\', ';', '/'} {
			for _, r := range got {
				if r == forbidden {
					t.Errorf("sanitizeFilename(%q) = %q, which still contains %q", in, got, forbidden)
				}
			}
		}
	}
}
