package domain

import (
	"testing"
	"time"
	"uuid"
)

func TestRefreshTokenUsability(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	used := now.Add(-time.Minute)

	tests := []struct {
		name  string
		token RefreshToken
		want  bool
	}{
		{
			name:  "fresh token",
			token: RefreshToken{ExpiresAt: now.Add(time.Hour)},
			want:  true,
		},
		{
			name:  "expired token",
			token: RefreshToken{ExpiresAt: now.Add(-time.Second)},
			want:  false,
		},
		{
			name:  "already exchanged",
			token: RefreshToken{ExpiresAt: now.Add(time.Hour), UsedAt: &used},
			want:  false,
		},
		{
			name:  "revoked",
			token: RefreshToken{ExpiresAt: now.Add(time.Hour), RevokedAt: &used},
			want:  false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.token.IsUsable(now); got != tc.want {
				t.Errorf("IsUsable = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestRefreshTokenIsConsumed covers the flag that distinguishes a replay from
// an ordinary rejection, which is what triggers revoking the whole chain.
func TestRefreshTokenIsConsumed(t *testing.T) {
	used := time.Now()

	if (&RefreshToken{}).IsConsumed() {
		t.Error("an unused token reports itself as consumed")
	}
	if !(&RefreshToken{UsedAt: &used}).IsConsumed() {
		t.Error("an exchanged token does not report itself as consumed")
	}
}

// TestRefreshTokenChainLinksToItsParent documents the shape rotation relies on.
func TestRefreshTokenChainLinksToItsParent(t *testing.T) {
	parentID := uuid.NewV7()
	successor := RefreshToken{ID: uuid.NewV7(), ParentID: &parentID}

	if successor.ParentID == nil || *successor.ParentID != parentID {
		t.Error("the successor does not point back at the token it replaced")
	}
	if successor.ID == parentID {
		t.Error("the successor reused its parent's identifier")
	}
}
