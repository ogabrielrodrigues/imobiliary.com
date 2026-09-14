package domain

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateBatchName(t *testing.T) {
	tests := []struct {
		name  string
		input string
		ok    bool
	}{
		{"a plain name", "Aditamentos de setembro", true},
		{"accents count as one character each", strings.Repeat("ç", MaxBatchNameLength), true},
		{"empty", "", false},
		{"only spaces", "   ", false},
		{"one character too long", strings.Repeat("a", MaxBatchNameLength+1), false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateBatchName(tc.input)
			if tc.ok && err != nil {
				t.Errorf("ValidateBatchName(%q) = %v, want nil", tc.input, err)
			}
			if !tc.ok && !errors.Is(err, ErrValidation) {
				t.Errorf("ValidateBatchName(%q) = %v, want a validation error", tc.input, err)
			}
		})
	}
}
