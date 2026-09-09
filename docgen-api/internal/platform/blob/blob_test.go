package blob

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()

	store, err := New(filepath.Join(t.TempDir(), "blobs"))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return store
}

func TestPutAndReadRoundTrip(t *testing.T) {
	store := newTestStore(t)
	content := []byte("the quick brown fox jumps over the lazy dog")

	hash, size, err := store.Put(bytes.NewReader(content))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if size != int64(len(content)) {
		t.Errorf("size = %d, want %d", size, len(content))
	}

	// The name must be the SHA-256 of the content, which is what makes the
	// store content-addressed rather than merely hashed.
	want := sha256.Sum256(content)
	if hash != hex.EncodeToString(want[:]) {
		t.Errorf("hash = %q, want the SHA-256 of the content", hash)
	}

	got, err := store.ReadAll(hash)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("ReadAll returned %q, want %q", got, content)
	}
}

// TestPutDeduplicatesIdenticalContent is the payoff of content addressing: two
// identical documents occupy one file.
func TestPutDeduplicatesIdenticalContent(t *testing.T) {
	store := newTestStore(t)
	content := []byte("identical content")

	first, _, err := store.Put(bytes.NewReader(content))
	if err != nil {
		t.Fatalf("first Put: %v", err)
	}
	second, _, err := store.Put(bytes.NewReader(content))
	if err != nil {
		t.Fatalf("second Put: %v", err)
	}

	if first != second {
		t.Errorf("identical content stored under two names: %q and %q", first, second)
	}
	if got := countFiles(t, store.root); got != 1 {
		t.Errorf("store holds %d objects, want 1", got)
	}
}

func TestPutLeavesNoTemporaryFiles(t *testing.T) {
	store := newTestStore(t)

	if _, _, err := store.Put(strings.NewReader("some content")); err != nil {
		t.Fatalf("Put: %v", err)
	}

	entries, err := os.ReadDir(store.tempDir)
	if err != nil {
		t.Fatalf("read temp directory: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("temp directory holds %d leftover files", len(entries))
	}
}

func TestOpenIsSeekable(t *testing.T) {
	store := newTestStore(t)
	content := []byte("0123456789")

	hash, _, err := store.Put(bytes.NewReader(content))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}

	handle, err := store.Open(hash)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer handle.Close()

	// Seeking is what lets the download handler answer range requests.
	if _, err := handle.Seek(5, io.SeekStart); err != nil {
		t.Fatalf("Seek: %v", err)
	}
	rest, err := io.ReadAll(handle)
	if err != nil {
		t.Fatalf("ReadAll after Seek: %v", err)
	}
	if string(rest) != "56789" {
		t.Errorf("read %q after seeking to offset 5, want %q", rest, "56789")
	}
}

// TestOpenRejectsMalformedHash is the guard that stops a hash taken from a
// request from being used to reach outside the store's directory.
func TestOpenRejectsMalformedHash(t *testing.T) {
	store := newTestStore(t)

	malformed := []string{
		"",
		"short",
		"../../../../etc/passwd",
		strings.Repeat("g", 64), // hex alphabet only
		strings.ToUpper(strings.Repeat("a", 64)),
		strings.Repeat("a", 63),
		strings.Repeat("a", 65),
	}

	for _, hash := range malformed {
		if _, err := store.Open(hash); !errors.Is(err, ErrInvalidHash) {
			t.Errorf("Open(%q) = %v, want ErrInvalidHash", hash, err)
		}
	}
}

func TestOpenReportsMissingObject(t *testing.T) {
	store := newTestStore(t)

	// Well formed, but nothing was ever stored under it.
	if _, err := store.Open(strings.Repeat("ab", 32)); err == nil {
		t.Error("Open on a missing object succeeded")
	}
}

func TestPutHandlesEmptyContent(t *testing.T) {
	store := newTestStore(t)

	hash, size, err := store.Put(bytes.NewReader(nil))
	if err != nil {
		t.Fatalf("Put: %v", err)
	}
	if size != 0 {
		t.Errorf("size = %d, want 0", size)
	}

	got, err := store.ReadAll(hash)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("ReadAll returned %d bytes, want 0", len(got))
	}
}

// countFiles counts the objects stored under root, ignoring the temp directory.
func countFiles(t *testing.T, root string) int {
	t.Helper()

	count := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if entry.Name() == "tmp" {
				return filepath.SkipDir
			}
			return nil
		}
		count++
		return nil
	})
	if err != nil {
		t.Fatalf("walk store: %v", err)
	}
	return count
}
