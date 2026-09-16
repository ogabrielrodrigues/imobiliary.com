package domain

import (
	"errors"
	"strings"
	"testing"
	"time"
	"uuid"
)

func fieldsOf(t *testing.T, err error) []string {
	t.Helper()
	var invalid *ValidationError
	if !errors.As(err, &invalid) {
		t.Fatalf("error %v is not a ValidationError", err)
	}
	names := make([]string, 0, len(invalid.Fields))
	for _, f := range invalid.Fields {
		names = append(names, f.Field)
	}
	return names
}

func TestValidateRegistration(t *testing.T) {
	if err := ValidateRegistration("ana@example.com", "Ana", "uma senha longa o suficiente", "Imobiliária Central"); err != nil {
		t.Fatalf("a valid registration was refused: %v", err)
	}

	cases := map[string]struct {
		email, name, password, organization string
		want                                []string
	}{
		"everything missing": {"", "", "", "", []string{"email", "name", "password", "organization_name"}},
		"short password":     {"ana@example.com", "Ana", strings.Repeat("a", MinPasswordLength-1), "Central", []string{"password"}},
		"long password":      {"ana@example.com", "Ana", strings.Repeat("a", MaxPasswordLength+1), "Central", []string{"password"}},
		"not an address":     {"ana@", "Ana", "uma senha longa o suficiente", "Central", []string{"email"}},
		"blank name":         {"ana@example.com", "   ", "uma senha longa o suficiente", "Central", []string{"name"}},
		"long organisation":  {"ana@example.com", "Ana", "uma senha longa o suficiente", strings.Repeat("x", MaxOrganizationNameLength+1), []string{"organization_name"}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := ValidateRegistration(c.email, c.name, c.password, c.organization)
			got := fieldsOf(t, err)
			if len(got) != len(c.want) {
				t.Fatalf("fields = %v, want %v", got, c.want)
			}
			for i, field := range c.want {
				if got[i] != field {
					t.Fatalf("fields = %v, want %v", got, c.want)
				}
			}
		})
	}

	// A password is counted in runes: an accented passphrase must not be
	// credited with the extra bytes of its encoding.
	if err := ValidateRegistration("ana@example.com", "Ana", strings.Repeat("é", MinPasswordLength-1), "Central"); err == nil {
		t.Fatal("a short passphrase passed because its bytes were counted")
	}
}

func TestNormalizeEmail(t *testing.T) {
	for in, want := range map[string]string{
		"  Ana@Example.COM ": "ana@example.com",
		"ana@example.com":    "ana@example.com",
	} {
		if got := NormalizeEmail(in); got != want {
			t.Errorf("NormalizeEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRoles(t *testing.T) {
	if !RoleAdmin.IsValid() || !RoleMember.IsValid() || Role("owner").IsValid() {
		t.Fatal("role validity is wrong")
	}
	if !(&Membership{Role: RoleAdmin}).IsAdmin() || (&Membership{Role: RoleMember}).IsAdmin() {
		t.Fatal("IsAdmin is wrong")
	}
	if !AdminsMustHaveTOTP(RoleAdmin) || AdminsMustHaveTOTP(RoleMember) {
		t.Fatal("the second factor rule is wrong")
	}
	if err := ValidateInvitation("ana@example.com", Role("owner")); err == nil {
		t.Fatal("an unknown role was accepted on an invitation")
	}
}

func TestRefreshTokenLifecycle(t *testing.T) {
	now := time.Date(2026, time.September, 16, 12, 0, 0, 0, time.UTC)
	fresh := &RefreshToken{ExpiresAt: now.Add(time.Hour)}
	used := &RefreshToken{ExpiresAt: now.Add(time.Hour), UsedAt: &now}
	revoked := &RefreshToken{ExpiresAt: now.Add(time.Hour), RevokedAt: &now}
	expired := &RefreshToken{ExpiresAt: now.Add(-time.Second)}

	if !fresh.IsUsable(now) || fresh.IsConsumed() {
		t.Error("a fresh token is not usable")
	}
	if used.IsUsable(now) || !used.IsConsumed() {
		t.Error("a consumed token is still usable")
	}
	if revoked.IsUsable(now) || expired.IsUsable(now) {
		t.Error("a revoked or expired token is still usable")
	}
}

func TestInvitationStatus(t *testing.T) {
	now := time.Date(2026, time.September, 16, 12, 0, 0, 0, time.UTC)
	earlier := now.Add(-time.Hour)

	cases := map[string]struct {
		invitation Invitation
		want       InvitationStatus
		usable     bool
	}{
		"pending":  {Invitation{ExpiresAt: now.Add(time.Hour)}, InvitationPending, true},
		"accepted": {Invitation{ExpiresAt: now.Add(time.Hour), AcceptedAt: &earlier}, InvitationAccepted, false},
		"revoked":  {Invitation{ExpiresAt: now.Add(time.Hour), RevokedAt: &earlier}, InvitationRevoked, false},
		"expired":  {Invitation{ExpiresAt: earlier}, InvitationExpired, false},
	}
	for name, c := range cases {
		if got := c.invitation.StatusAt(now); got != c.want {
			t.Errorf("%s: status = %q, want %q", name, got, c.want)
		}
		if got := c.invitation.IsUsable(now); got != c.usable {
			t.Errorf("%s: usable = %v, want %v", name, got, c.usable)
		}
	}
}

func TestUserAndChallengeState(t *testing.T) {
	now := time.Date(2026, time.September, 16, 12, 0, 0, 0, time.UTC)
	if (&User{}).HasTOTP() || !(&User{TOTPConfirmedAt: &now}).HasTOTP() {
		t.Error("HasTOTP is wrong")
	}

	challenge := &MFAChallenge{ID: uuid.NewV7(), ExpiresAt: now.Add(5 * time.Minute)}
	if !challenge.IsUsable(now) {
		t.Error("a fresh challenge is not usable")
	}
	challenge.UsedAt = &now
	if challenge.IsUsable(now) {
		t.Error("a spent challenge is still usable")
	}
	if (&MFAChallenge{ExpiresAt: now.Add(-time.Second)}).IsUsable(now) {
		t.Error("an expired challenge is still usable")
	}

	reset := &PasswordReset{ExpiresAt: now.Add(time.Minute)}
	if !reset.IsUsable(now) {
		t.Error("a fresh reset is not usable")
	}
	reset.UsedAt = &now
	if reset.IsUsable(now) {
		t.Error("a spent reset is still usable")
	}
}
