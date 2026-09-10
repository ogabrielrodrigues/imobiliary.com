// Package blob stores opaque byte streams on the local filesystem, addressed by
// the SHA-256 of their content.
//
// Content addressing gives deduplication for free: two identical documents
// occupy one file. It also means a stored object can never be silently
// modified, since changing the bytes changes the name.
package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// ErrInvalidHash is returned when a caller supplies something that is not a
// hex-encoded SHA-256 digest. Validating the shape is what keeps a hash taken
// from a request from escaping the store's directory.
var ErrInvalidHash = errors.New("blob: invalid hash")

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Store is a content-addressed blob store rooted at a directory.
type Store struct {
	root    string
	tempDir string
}

// New prepares a store rooted at dir, creating it if necessary.
func New(dir string) (*Store, error) {
	tempDir := filepath.Join(dir, "tmp")
	if err := os.MkdirAll(tempDir, 0o700); err != nil {
		return nil, fmt.Errorf("blob: create store: %w", err)
	}
	return &Store{root: dir, tempDir: tempDir}, nil
}

// Put streams r into the store and returns the hash and byte count of what was
// written.
//
// The data lands in a temporary file first and is moved into place only once it
// is fully written and its name is known, so a crash mid-write can never leave
// a truncated object visible under a valid hash.
func (s *Store) Put(r io.Reader) (hash string, size int64, err error) {
	tmp, err := os.CreateTemp(s.tempDir, "put-*")
	if err != nil {
		return "", 0, fmt.Errorf("blob: create temp file: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		// Removing a file that was already renamed away is expected to fail;
		// this only cleans up the error paths.
		if err != nil {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	digest := sha256.New()
	size, err = io.Copy(io.MultiWriter(tmp, digest), r)
	if err != nil {
		return "", 0, fmt.Errorf("blob: write: %w", err)
	}
	if err = tmp.Sync(); err != nil {
		return "", 0, fmt.Errorf("blob: sync: %w", err)
	}
	if err = tmp.Close(); err != nil {
		return "", 0, fmt.Errorf("blob: close: %w", err)
	}

	hash = hex.EncodeToString(digest.Sum(nil))
	dst := s.pathFor(hash)
	if err = os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", 0, fmt.Errorf("blob: create shard: %w", err)
	}

	// An existing object with this hash already holds exactly these bytes, so
	// the write is complete: drop the temporary copy instead of replacing it.
	// This also avoids os.Rename failing on an existing destination, which is
	// how Windows behaves.
	if _, statErr := os.Stat(dst); statErr == nil {
		os.Remove(tmpName)
		return hash, size, nil
	}
	if err = os.Rename(tmpName, dst); err != nil {
		return "", 0, fmt.Errorf("blob: commit: %w", err)
	}
	return hash, size, nil
}

// Open returns a readable handle on the stored object. The caller closes it.
//
// The result is seekable so that an HTTP handler can serve it with
// http.ServeContent, which needs to seek in order to answer range requests.
func (s *Store) Open(hash string) (io.ReadSeekCloser, error) {
	if !hashPattern.MatchString(hash) {
		return nil, ErrInvalidHash
	}
	f, err := os.Open(s.pathFor(hash))
	if err != nil {
		return nil, fmt.Errorf("blob: open %s: %w", hash, err)
	}
	return f, nil
}

// ReadAll loads a stored object entirely into memory. It suits templates, which
// are bounded in size and immediately parsed; documents are streamed instead.
func (s *Store) ReadAll(hash string) ([]byte, error) {
	f, err := s.Open(hash)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

// Delete removes a stored object.
//
// Content addressing means one file can be the body of several rows: two
// accounts that generate byte-identical documents share it. So the caller
// must establish that nothing refers to the hash any more before calling
// this - the store itself has no idea who points at what.
//
// An object that is already gone is not an error. Erasure is expressed as an
// end state, and a retry after a partial failure should be able to finish.
func (s *Store) Delete(hash string) error {
	if !hashPattern.MatchString(hash) {
		return ErrInvalidHash
	}
	if err := os.Remove(s.pathFor(hash)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("blob: delete %s: %w", hash, err)
	}
	return nil
}

// pathFor shards objects two levels deep by the leading bytes of the hash, so
// no single directory ends up holding every object.
func (s *Store) pathFor(hash string) string {
	return filepath.Join(s.root, hash[0:2], hash[2:4], hash)
}
