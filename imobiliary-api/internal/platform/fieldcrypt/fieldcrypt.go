// Package fieldcrypt encrypts individual database fields and derives the
// blind indexes that let an encrypted field still be looked up by value.
//
// A CPF, a birth date or a phone number is sealed with AES-256-GCM before it
// reaches the database, so a copy of the database, a backup or a careless
// query yields ciphertext. Names and addresses are not sealed: they must stay
// searchable, and they are protected by access control and disk encryption
// instead.
package fieldcrypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// KeySize is the length of every key, in bytes: AES-256 and a 256-bit HMAC key.
const KeySize = 32

// nonceSize is the standard GCM nonce length.
const nonceSize = 12

// ErrDecrypt covers every reason a sealed value could not be opened: a
// tampered byte, a value moved to another row, an unknown key version. The
// reasons are not told apart, because none of them is recoverable and naming
// them only helps someone probing the data.
var ErrDecrypt = errors.New("fieldcrypt: cannot open sealed value")

// Keyring holds the encryption keys by version and the blind-index key.
//
// Every sealed value starts with the version of the key that sealed it. New
// values always use the newest version, and older versions stay available for
// reading, which is what makes rotation possible: add a key, and re-seal old
// rows at leisure.
type Keyring struct {
	current byte
	aeads   map[byte]cipher.AEAD
	index   []byte
}

// New builds a keyring. keys maps a version (1-255) to a 32-byte key; the
// highest version seals new values. indexKey is the blind-index key.
func New(keys map[byte][]byte, indexKey []byte) (*Keyring, error) {
	if len(keys) == 0 {
		return nil, errors.New("fieldcrypt: at least one encryption key is required")
	}
	if len(indexKey) != KeySize {
		return nil, fmt.Errorf("fieldcrypt: index key must be %d bytes", KeySize)
	}

	k := &Keyring{aeads: make(map[byte]cipher.AEAD, len(keys))}
	for version, key := range keys {
		if version == 0 {
			return nil, errors.New("fieldcrypt: key version 0 is reserved")
		}
		if len(key) != KeySize {
			return nil, fmt.Errorf("fieldcrypt: key version %d must be %d bytes", version, KeySize)
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, fmt.Errorf("fieldcrypt: key version %d: %w", version, err)
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, fmt.Errorf("fieldcrypt: key version %d: %w", version, err)
		}
		k.aeads[version] = aead
		k.current = max(k.current, version)
	}
	k.index = append([]byte(nil), indexKey...)
	return k, nil
}

// ParseKeys reads encryption keys written as "1:<base64>,2:<base64>", the form
// they take in the environment.
func ParseKeys(spec string) (map[byte][]byte, error) {
	keys := make(map[byte][]byte)
	for entry := range strings.SplitSeq(spec, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		rawVersion, rawKey, found := strings.Cut(entry, ":")
		if !found {
			return nil, errors.New("fieldcrypt: a key must be written as <version>:<base64>")
		}
		version, err := strconv.ParseUint(rawVersion, 10, 8)
		if err != nil || version == 0 {
			return nil, fmt.Errorf("fieldcrypt: key version %q must be between 1 and 255", rawVersion)
		}
		if _, dup := keys[byte(version)]; dup {
			return nil, fmt.Errorf("fieldcrypt: key version %d appears twice", version)
		}
		key, err := DecodeKey(rawKey)
		if err != nil {
			return nil, fmt.Errorf("fieldcrypt: key version %d: %w", version, err)
		}
		keys[byte(version)] = key
	}
	return keys, nil
}

// DecodeKey reads one base64 key and checks its length.
func DecodeKey(raw string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return nil, errors.New("key is not valid base64")
	}
	if len(key) != KeySize {
		return nil, fmt.Errorf("key must decode to %d bytes, got %d", KeySize, len(key))
	}
	return key, nil
}

// Context binds a sealed value to where it lives. Opening a value under a
// different context fails, so a ciphertext copied from one person's row into
// another's, or from one column into another, is rejected rather than read.
type Context struct {
	Table  string
	Column string
	RowID  [16]byte
}

// additionalData encodes the context unambiguously: each string is length
// prefixed, so ("ab", "c") and ("a", "bc") never produce the same bytes.
func (c Context) additionalData() []byte {
	out := make([]byte, 0, 4+len(c.Table)+4+len(c.Column)+len(c.RowID))
	out = binary.BigEndian.AppendUint32(out, uint32(len(c.Table)))
	out = append(out, c.Table...)
	out = binary.BigEndian.AppendUint32(out, uint32(len(c.Column)))
	out = append(out, c.Column...)
	return append(out, c.RowID[:]...)
}

// Seal encrypts plaintext for the given context. The result is
// version ‖ nonce ‖ ciphertext ‖ tag.
func (k *Keyring) Seal(plaintext []byte, ctx Context) ([]byte, error) {
	aead := k.aeads[k.current]
	out := make([]byte, 1+nonceSize, 1+nonceSize+len(plaintext)+aead.Overhead())
	out[0] = k.current
	if _, err := rand.Read(out[1 : 1+nonceSize]); err != nil {
		return nil, fmt.Errorf("fieldcrypt: read nonce: %w", err)
	}
	return aead.Seal(out, out[1:1+nonceSize], plaintext, ctx.additionalData()), nil
}

// Open decrypts a value sealed by Seal under the same context.
func (k *Keyring) Open(sealed []byte, ctx Context) ([]byte, error) {
	if len(sealed) < 1+nonceSize {
		return nil, ErrDecrypt
	}
	aead, ok := k.aeads[sealed[0]]
	if !ok {
		return nil, ErrDecrypt
	}
	plaintext, err := aead.Open(nil, sealed[1:1+nonceSize], sealed[1+nonceSize:], ctx.additionalData())
	if err != nil {
		return nil, ErrDecrypt
	}
	return plaintext, nil
}

// NeedsResealing reports whether a value was sealed with an older key.
func (k *Keyring) NeedsResealing(sealed []byte) bool {
	return len(sealed) > 0 && sealed[0] != k.current
}

// Index derives the blind index of a normalised value within a scope.
//
// The scope is the organisation. The same CPF registered by two offices
// therefore produces two unrelated indexes, and the index column cannot be
// used to tell that two organisations hold the same person.
//
// Unlike the encryption keys, the index key cannot simply be rotated: every
// index would have to be recomputed from decrypted values at once.
func (k *Keyring) Index(scope [16]byte, value string) []byte {
	mac := hmac.New(sha256.New, k.index)
	mac.Write(scope[:])
	mac.Write([]byte(value))
	return mac.Sum(nil)
}

// CurrentVersion is the key version new values are sealed with.
func (k *Keyring) CurrentVersion() byte { return k.current }
