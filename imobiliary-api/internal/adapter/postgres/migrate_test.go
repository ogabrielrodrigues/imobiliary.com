package postgres

import (
	"errors"
	"testing"
)

func TestEmbeddedMigrationsAreWellFormed(t *testing.T) {
	migrations, err := Migrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(migrations) == 0 {
		t.Fatal("no migration is embedded")
	}
	for i, m := range migrations {
		if m.Version != i+1 || m.SQL == "" {
			t.Errorf("migration %d is %+v", i+1, m.Name)
		}
	}
}

func TestCompare(t *testing.T) {
	embedded := []Migration{{Version: 1, Checksum: [32]byte{1}}, {Version: 2, Checksum: [32]byte{2}}}
	sum := func(b byte) []byte { c := [32]byte{b}; return c[:] }

	cases := []struct {
		name    string
		applied []appliedMigration
		want    error
	}{
		{"current", []appliedMigration{{1, sum(1)}, {2, sum(2)}}, nil},
		{"behind", []appliedMigration{{1, sum(1)}}, ErrSchemaBehind},
		{"empty", nil, ErrSchemaBehind},
		{"ahead", []appliedMigration{{1, sum(1)}, {2, sum(2)}, {3, sum(3)}}, ErrSchemaAhead},
		{"changed", []appliedMigration{{1, sum(9)}}, ErrMigrationChanged},
		{"gap", []appliedMigration{{2, sum(2)}}, ErrSchemaAhead},
	}
	for _, c := range cases {
		err := compare(embedded, c.applied)
		if (c.want == nil) != (err == nil) || (c.want != nil && !errors.Is(err, c.want)) {
			t.Errorf("%s: compare = %v, want %v", c.name, err, c.want)
		}
	}
}
