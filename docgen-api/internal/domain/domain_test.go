package domain

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeEmail(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"ada@example.com", "ada@example.com"},
		{"  ADA@Example.COM  ", "ada@example.com"},
		{"Ada.Lovelace+tag@Example.com", "ada.lovelace+tag@example.com"},
	}

	for _, tc := range tests {
		if got := NormalizeEmail(tc.in); got != tc.want {
			t.Errorf("NormalizeEmail(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestIsValidPlaceholderName(t *testing.T) {
	valid := []string{"name", "customer_name", "line_1", "a"}
	for _, name := range valid {
		if !IsValidPlaceholderName(name) {
			t.Errorf("IsValidPlaceholderName(%q) = false, want true", name)
		}
	}

	invalid := []string{
		"",
		"CustomerName",        // uppercase
		"_leading_underscore", // must start with a letter
		"1leading_digit",
		"has-hyphen",
		"has space",
		"has.dot",
		strings.Repeat("a", MaxPlaceholderNameLength+1),
	}
	for _, name := range invalid {
		if IsValidPlaceholderName(name) {
			t.Errorf("IsValidPlaceholderName(%q) = true, want false", name)
		}
	}
}

func TestValidateDocumentData(t *testing.T) {
	placeholders := []string{"customer_name", "amount"}

	t.Run("accepts an exact match", func(t *testing.T) {
		err := ValidateDocumentData(placeholders, map[string]string{
			"customer_name": "Ada",
			"amount":        "100",
		})
		if err != nil {
			t.Errorf("ValidateDocumentData = %v, want nil", err)
		}
	})

	t.Run("rejects a missing field", func(t *testing.T) {
		err := ValidateDocumentData(placeholders, map[string]string{"customer_name": "Ada"})

		var invalid *ValidationError
		if !errors.As(err, &invalid) {
			t.Fatalf("error = %v, want a validation error", err)
		}
		if !mentionsField(invalid, "data.amount") {
			t.Errorf("error does not name the missing field: %v", invalid.Fields)
		}
	})

	// Silently dropping an unknown key would produce a document missing content
	// the caller believed it had supplied, so a typo must be reported.
	t.Run("rejects an unknown field", func(t *testing.T) {
		err := ValidateDocumentData(placeholders, map[string]string{
			"customer_name": "Ada",
			"amount":        "100",
			"amont":         "typo",
		})

		var invalid *ValidationError
		if !errors.As(err, &invalid) {
			t.Fatalf("error = %v, want a validation error", err)
		}
		if !mentionsField(invalid, "data.amont") {
			t.Errorf("error does not name the unknown field: %v", invalid.Fields)
		}
	})

	t.Run("rejects an oversized value", func(t *testing.T) {
		err := ValidateDocumentData(placeholders, map[string]string{
			"customer_name": strings.Repeat("x", MaxDocumentDataValueLength+1),
			"amount":        "100",
		})
		if !errors.Is(err, ErrValidation) {
			t.Errorf("error = %v, want a validation error", err)
		}
	})

	t.Run("accepts a template with no placeholders", func(t *testing.T) {
		if err := ValidateDocumentData(nil, map[string]string{}); err != nil {
			t.Errorf("ValidateDocumentData = %v, want nil", err)
		}
	})
}

func TestValidateTemplateMetadata(t *testing.T) {
	if err := ValidateTemplateMetadata("Contract", "A standard agreement"); err != nil {
		t.Errorf("ValidateTemplateMetadata on valid input = %v", err)
	}
	if err := ValidateTemplateMetadata("   ", ""); !errors.Is(err, ErrValidation) {
		t.Errorf("an empty name = %v, want a validation error", err)
	}
	if err := ValidateTemplateMetadata(strings.Repeat("n", MaxTemplateNameLength+1), ""); !errors.Is(err, ErrValidation) {
		t.Errorf("an overlong name = %v, want a validation error", err)
	}
	if err := ValidateTemplateMetadata("Contract", strings.Repeat("d", MaxTemplateDescriptionLength+1)); !errors.Is(err, ErrValidation) {
		t.Errorf("an overlong description = %v, want a validation error", err)
	}
}

// TestValidationErrorIsErrValidation pins the behaviour the HTTP layer relies
// on to map these errors to a 422 without a type assertion.
func TestValidationErrorIsErrValidation(t *testing.T) {
	v := &ValidationError{}
	v.Add("field", "is wrong")

	if !errors.Is(v, ErrValidation) {
		t.Error("a ValidationError does not satisfy errors.Is(err, ErrValidation)")
	}
	if errors.Is(v, ErrNotFound) {
		t.Error("a ValidationError wrongly matches ErrNotFound")
	}
	if !strings.Contains(v.Error(), "field") {
		t.Errorf("Error() = %q, want it to name the field", v.Error())
	}
}

func TestValidationErrorOrNil(t *testing.T) {
	empty := &ValidationError{}
	if err := empty.OrNil(); err != nil {
		t.Errorf("OrNil on an empty error = %v, want nil", err)
	}

	populated := &ValidationError{}
	populated.Addf("field", "must be at most %d", 10)
	if err := populated.OrNil(); err == nil {
		t.Error("OrNil on a populated error = nil, want the error")
	}
}

// mentionsField reports whether any recorded problem concerns the named field.
func mentionsField(v *ValidationError, field string) bool {
	for _, f := range v.Fields {
		if f.Field == field {
			return true
		}
	}
	return false
}
