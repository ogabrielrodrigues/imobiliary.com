// Package sealing adapts the field keyring to the port the use cases declare.
//
// The use cases say what they need in their own terms, a value sealed against
// the row it belongs to; fieldcrypt knows about AEADs, nonces and key
// versions. This file is the whole of the translation.
package sealing

import (
	"uuid"

	"imobiliary/internal/platform/fieldcrypt"
	"imobiliary/internal/usecase"
)

// Sealer seals values with a keyring.
type Sealer struct {
	keys *fieldcrypt.Keyring
}

// New returns a sealer over a keyring.
func New(keys *fieldcrypt.Keyring) *Sealer { return &Sealer{keys: keys} }

// Seal encrypts a value for one column of one row.
func (s *Sealer) Seal(plaintext []byte, table, column string, rowID uuid.UUID) ([]byte, error) {
	return s.keys.Seal(plaintext, fieldcrypt.Context{Table: table, Column: column, RowID: rowID})
}

// Open decrypts a value sealed for that same place. A value moved anywhere
// else fails to open rather than being read as someone else's.
func (s *Sealer) Open(sealed []byte, table, column string, rowID uuid.UUID) ([]byte, error) {
	return s.keys.Open(sealed, fieldcrypt.Context{Table: table, Column: column, RowID: rowID})
}

// Index derives a blind index scoped to an office.
func (s *Sealer) Index(organizationID uuid.UUID, value string) []byte {
	return s.keys.Index(organizationID, value)
}

var _ usecase.Sealer = (*Sealer)(nil)
