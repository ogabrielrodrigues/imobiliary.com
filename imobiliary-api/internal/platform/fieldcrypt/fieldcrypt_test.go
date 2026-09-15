package fieldcrypt

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"uuid"
)

func randomKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, KeySize)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	return key
}

func newKeyring(t *testing.T, keys map[byte][]byte) *Keyring {
	t.Helper()
	k, err := New(keys, randomKey(t))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func personCPF(row uuid.UUID) Context {
	return Context{Table: "individuals", Column: "identity", RowID: row}
}

func TestSealOpenRoundTrip(t *testing.T) {
	k := newKeyring(t, map[byte][]byte{1: randomKey(t)})
	ctx := personCPF(uuid.NewV7())

	sealed, err := k.Seal([]byte("52998224725"), ctx)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("52998224725")) {
		t.Fatal("the sealed value contains the plaintext")
	}
	opened, err := k.Open(sealed, ctx)
	if err != nil || string(opened) != "52998224725" {
		t.Fatalf("Open = %q, %v", opened, err)
	}

	again, err := k.Seal([]byte("52998224725"), ctx)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(sealed, again) {
		t.Fatal("sealing the same value twice produced the same bytes; the nonce is not random")
	}
}

func TestOpenRejectsAValueMovedElsewhere(t *testing.T) {
	k := newKeyring(t, map[byte][]byte{1: randomKey(t)})
	row := uuid.NewV7()
	sealed, err := k.Seal([]byte("52998224725"), personCPF(row))
	if err != nil {
		t.Fatal(err)
	}

	elsewhere := map[string]Context{
		"another row":    personCPF(uuid.NewV7()),
		"another column": {Table: "individuals", Column: "phone", RowID: row},
		"another table":  {Table: "companies", Column: "identity", RowID: row},
		// Length prefixes keep a shifted boundary from producing the same bytes.
		"shifted boundary": {Table: "individualsi", Column: "dentity", RowID: row},
	}
	for name, ctx := range elsewhere {
		if _, err := k.Open(sealed, ctx); !errors.Is(err, ErrDecrypt) {
			t.Errorf("%s: Open error = %v, want ErrDecrypt", name, err)
		}
	}
}

func TestOpenRejectsTampering(t *testing.T) {
	k := newKeyring(t, map[byte][]byte{1: randomKey(t)})
	ctx := personCPF(uuid.NewV7())
	sealed, err := k.Seal([]byte("52998224725"), ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := range sealed {
		tampered := bytes.Clone(sealed)
		tampered[i] ^= 0x01
		if _, err := k.Open(tampered, ctx); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("flipping byte %d: Open error = %v, want ErrDecrypt", i, err)
		}
	}
	if _, err := k.Open(sealed[:10], ctx); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("truncated value: Open error = %v, want ErrDecrypt", err)
	}
}

func TestRotation(t *testing.T) {
	oldKey, newKey := randomKey(t), randomKey(t)
	ctx := personCPF(uuid.NewV7())

	before := newKeyring(t, map[byte][]byte{1: oldKey})
	sealedWithOld, err := before.Seal([]byte("secret"), ctx)
	if err != nil {
		t.Fatal(err)
	}

	after := newKeyring(t, map[byte][]byte{1: oldKey, 2: newKey})
	opened, err := after.Open(sealedWithOld, ctx)
	if err != nil || string(opened) != "secret" {
		t.Fatalf("a value sealed before rotation no longer opens: %q, %v", opened, err)
	}
	if !after.NeedsResealing(sealedWithOld) {
		t.Fatal("a value sealed with key 1 is not reported as needing resealing")
	}
	sealedWithNew, err := after.Seal([]byte("secret"), ctx)
	if err != nil {
		t.Fatal(err)
	}
	if sealedWithNew[0] != 2 || after.NeedsResealing(sealedWithNew) {
		t.Fatalf("new values are sealed with version %d, want 2", sealedWithNew[0])
	}

	retired := newKeyring(t, map[byte][]byte{2: newKey})
	if _, err := retired.Open(sealedWithOld, ctx); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("a retired key version still opens values: %v", err)
	}
}

func TestIndexIsScopedToTheOrganization(t *testing.T) {
	k := newKeyring(t, map[byte][]byte{1: randomKey(t)})
	orgA, orgB := uuid.NewV7(), uuid.NewV7()

	if !bytes.Equal(k.Index(orgA, "52998224725"), k.Index(orgA, "52998224725")) {
		t.Fatal("the index of one value is not stable")
	}
	if bytes.Equal(k.Index(orgA, "52998224725"), k.Index(orgB, "52998224725")) {
		t.Fatal("two organisations produce the same index for one person")
	}
	if bytes.Equal(k.Index(orgA, "52998224725"), k.Index(orgA, "11144477735")) {
		t.Fatal("two values produce the same index")
	}
}

func TestParseKeys(t *testing.T) {
	a := base64.StdEncoding.EncodeToString(randomKey(t))
	b := base64.StdEncoding.EncodeToString(randomKey(t))

	keys, err := ParseKeys("1:" + a + ", 2:" + b)
	if err != nil || len(keys) != 2 {
		t.Fatalf("ParseKeys = %d keys, %v", len(keys), err)
	}

	for name, spec := range map[string]string{
		"no version":      a,
		"version zero":    "0:" + a,
		"version too big": "256:" + a,
		"duplicate":       "1:" + a + ",1:" + b,
		"not base64":      "1:!!!",
		"short key":       "1:" + base64.StdEncoding.EncodeToString([]byte("short")),
	} {
		if _, err := ParseKeys(spec); err == nil {
			t.Errorf("%s: ParseKeys accepted %q", name, spec)
		}
	}

	if _, err := New(map[byte][]byte{1: randomKey(t)}, []byte(strings.Repeat("x", 16))); err == nil {
		t.Error("New accepted a short index key")
	}
	if _, err := New(nil, randomKey(t)); err == nil {
		t.Error("New accepted an empty keyring")
	}
}
