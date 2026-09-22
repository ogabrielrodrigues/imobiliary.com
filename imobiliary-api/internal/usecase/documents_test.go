package usecase

import (
	"os"
	"strings"
	"testing"

	"imobiliary/internal/domain"
)

// The catalogue an office marks its models with is only useful if it is
// written down. This fails when a field is added to the code and not to
// docs/campos.md, which is the document the office reads.
func TestEveryFieldIsDocumented(t *testing.T) {
	doc, err := os.ReadFile("../../docs/campos.md")
	if err != nil {
		t.Fatalf("read docs/campos.md: %v", err)
	}
	text := string(doc)

	// Per-party fields are documented by their suffix, since the prefix and
	// the number are explained once and repeating 336 rows would help nobody.
	for _, suffix := range domain.PersonFieldSuffixes {
		if !strings.Contains(text, "`"+suffix+"`") {
			t.Errorf("docs/campos.md does not document the party field %q", suffix)
		}
	}

	for _, name := range contractFieldNames {
		if !strings.Contains(text, "`"+name+"`") {
			t.Errorf("docs/campos.md does not document %q", name)
		}
	}
	for _, suffix := range roleSuffixes {
		// Documented under one role, with a line saying to swap the prefix.
		if !strings.Contains(text, "`locador_"+suffix+"`") {
			t.Errorf("docs/campos.md does not document the role field %q", suffix)
		}
	}

	// A payout statement's own fields, its numbered properties by the first,
	// and the beneficiary by the prefix, since the suffixes are the parties'.
	for _, name := range payoutFieldNames {
		if !strings.Contains(text, "`"+name+"`") {
			t.Errorf("docs/campos.md does not document the payout field %q", name)
		}
	}
	for _, suffix := range payoutPropertySuffixes {
		if !strings.Contains(text, "`imovel_1_"+suffix+"`") {
			t.Errorf("docs/campos.md does not document the payout property field %q", suffix)
		}
	}
	if !strings.Contains(text, "`proprietario_nome`") {
		t.Error("docs/campos.md does not document the beneficiary's fields")
	}
}

// The names themselves must be what the document service accepts, or a model
// marked from this catalogue is refused at upload.
func TestFieldNamesAreValidPlaceholders(t *testing.T) {
	// A contract and a payout statement are separate documents: each list has
	// no name twice, and the two may share one, such as hoje.
	for what, names := range map[string][]string{"contract": DocumentFieldNames, "payout": PayoutFieldNames} {
		seen := map[string]bool{}
		for _, name := range names {
			if seen[name] {
				t.Errorf("%s field %q is listed twice", what, name)
			}
			seen[name] = true

			if name == "" || name[0] < 'a' || name[0] > 'z' {
				t.Errorf("field %q does not start with a lowercase letter", name)
				continue
			}
			for _, r := range name {
				if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' {
					t.Errorf("field %q holds %q, which the document service rejects", name, r)
					break
				}
			}
		}
	}
}
