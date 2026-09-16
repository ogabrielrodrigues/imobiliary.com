//go:build integration

package http_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"imobiliary/internal/domain"
)

// The data subject's rights over their own account: the copy (LGPD art. 18,
// II) and the erasure (art. 18, VI).

func TestExportIsTheWholeAccountWithoutItsSecrets(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana Souza", "Central")
	a.enrollTOTP(admin)
	member := a.invite(admin, "carla@example.com")

	resp := a.expect(http.StatusOK, http.MethodGet, "/v1/me/export", admin.access, nil)
	var export struct {
		Account struct {
			Email string `json:"email"`
		} `json:"account"`
		Memberships []struct {
			Role string `json:"role"`
		} `json:"memberships"`
		SecondFactor struct {
			Enabled           bool `json:"enabled"`
			RecoveryCodesLeft int  `json:"recovery_codes_left"`
		} `json:"second_factor"`
		Sessions    []map[string]any `json:"sessions"`
		AuditEvents []struct {
			Action string `json:"action"`
		} `json:"audit_events"`
		AccessRecords []struct {
			Event string `json:"event"`
			IP    string `json:"ip"`
		} `json:"access_records"`
	}
	resp.decode(t, &export)

	if export.Account.Email != admin.email {
		t.Errorf("account email = %q", export.Account.Email)
	}
	if len(export.Memberships) != 1 || export.Memberships[0].Role != "admin" {
		t.Errorf("memberships = %+v", export.Memberships)
	}
	if !export.SecondFactor.Enabled || export.SecondFactor.RecoveryCodesLeft != len(admin.recovery) {
		t.Errorf("second factor = %+v", export.SecondFactor)
	}
	if len(export.Sessions) == 0 {
		t.Error("no sessions exported")
	}
	var actions []string
	for _, e := range export.AuditEvents {
		actions = append(actions, e.Action)
	}
	for _, want := range []domain.AuditAction{
		domain.ActionUserRegistered, domain.ActionTOTPEnabled, domain.ActionInvitationSent,
	} {
		if !contains(actions, string(want)) {
			t.Errorf("the export has no %s: %v", want, actions)
		}
	}
	if len(export.AccessRecords) == 0 || export.AccessRecords[0].IP == "" {
		t.Errorf("access records = %+v", export.AccessRecords)
	}

	// Nothing in it would let anyone act as the account.
	body := string(resp.body)
	for _, secret := range []string{"$argon2id", admin.secret, admin.refresh, admin.recovery[0]} {
		if strings.Contains(body, secret) {
			t.Errorf("the export carries a secret: %q", secret)
		}
	}

	// The invitation shows on the side of the person invited.
	invited := a.expect(http.StatusOK, http.MethodGet, "/v1/me/export", member.access, nil)
	var received struct {
		Invitations []struct {
			OrganizationName string `json:"organization_name"`
			Status           string `json:"status"`
		} `json:"invitations_received"`
	}
	invited.decode(t, &received)
	if len(received.Invitations) != 1 || received.Invitations[0].OrganizationName != "Central" ||
		received.Invitations[0].Status != "accepted" {
		t.Errorf("invitations received = %+v", received.Invitations)
	}

	// Handing over a copy is itself recorded.
	var exported int
	if err := a.db.QueryRowForTest(t.Context(),
		`SELECT count(*) FROM audit_events WHERE action = $1`, string(domain.ActionDataExported),
	).Scan(&exported); err != nil {
		t.Fatal(err)
	}
	if exported != 2 {
		t.Errorf("recorded %d exports, want 2", exported)
	}
}

func TestDeletingAnAccountErasesItAndKeepsWhatTheLawRequires(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)
	member := a.invite(admin, "carla@example.com")

	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/me/deletion", member.access,
		map[string]any{"password": ""})
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/me/deletion", member.access,
		map[string]any{"password": "esta não é a senha"})
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/me/deletion", member.access,
		map[string]any{"password": testPassword})

	// Gone, in every way a client could try.
	a.expect(http.StatusUnauthorized, http.MethodGet, "/v1/me", member.access, nil)
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/refresh", "",
		map[string]any{"refresh_token": member.refresh})
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions", "",
		map[string]any{"email": member.email, "password": testPassword})
	if subject := a.mail.last(t, member.email).Subject; !strings.Contains(subject, "excluída") {
		t.Errorf("the last message to the account was %q", subject)
	}

	var members struct {
		Members []map[string]any `json:"members"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/organization/members", admin.access, nil).decode(t, &members)
	if len(members.Members) != 1 {
		t.Errorf("the office still lists %d members", len(members.Members))
	}

	// The access records still name the account, and the address that
	// identified it is kept sealed, not readable.
	var records int
	var sealed []byte
	if err := a.db.QueryRowForTest(t.Context(),
		`SELECT (SELECT count(*) FROM access_records WHERE user_id = $1),
		        (SELECT email FROM closed_accounts WHERE user_id = $1)`, member.userID,
	).Scan(&records, &sealed); err != nil {
		t.Fatal(err)
	}
	if records == 0 {
		t.Error("the access records lost the account")
	}
	if strings.Contains(string(sealed), member.email) {
		t.Error("the closed account keeps the address in the clear")
	}

	// The office's trail says the member left, without naming them any more.
	var withActor, left int
	if err := a.db.QueryRowForTest(t.Context(),
		`SELECT count(*) FILTER (WHERE actor_id IS NOT NULL), count(*)
		   FROM audit_events WHERE action = $1 AND organization_id IS NOT NULL`,
		string(domain.ActionAccountDeleted),
	).Scan(&withActor, &left); err != nil {
		t.Fatal(err)
	}
	if left != 1 || withActor != 0 {
		t.Errorf("deletion events: %d, %d still naming the actor", left, withActor)
	}

	// The address is free again.
	a.invite(admin, member.email)

	// And what was kept goes after six months.
	purged, err := a.db.Repositories().Audit.PurgeClosedAccounts(t.Context(), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if purged != 1 {
		t.Errorf("purged %d closed accounts, want 1", purged)
	}
}

func TestTheOnlyAdministratorCannotLeaveMembersBehind(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)
	member := a.invite(admin, "carla@example.com")

	refused := a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/me/deletion", admin.access,
		map[string]any{"password": testPassword})
	if !strings.Contains(string(refused.body), `"organizations"`) {
		t.Fatalf("the refusal says %s", refused.body)
	}

	a.expect(http.StatusNoContent, http.MethodPatch,
		"/v1/organization/members/"+member.userID, admin.access, map[string]any{"role": "admin"})
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/me/deletion", admin.access,
		map[string]any{"password": testPassword})

	// The office stays, with the person now running it.
	a.enrollTOTP(member)
	a.expect(http.StatusOK, http.MethodGet, "/v1/organization", member.access, nil)
}

func TestTheSoleMemberClosesTheOfficeWithTheAccount(t *testing.T) {
	a := newAPI(t)
	// Not enrolled: leaving must not wait for a second factor.
	admin := a.register("ana@example.com", "Ana", "Central")
	a.expect(http.StatusOK, http.MethodGet, "/v1/me/export", admin.access, nil)
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/me/deletion", admin.access,
		map[string]any{"password": testPassword})

	var offices, orphaned int
	if err := a.db.QueryRowForTest(t.Context(),
		`SELECT (SELECT count(*) FROM organizations),
		        (SELECT count(*) FROM audit_events WHERE action = $1 AND organization_id IS NULL)`,
		string(domain.ActionAccountDeleted),
	).Scan(&offices, &orphaned); err != nil {
		t.Fatal(err)
	}
	if offices != 0 || orphaned != 1 {
		t.Errorf("%d offices left, %d deletion events without an office", offices, orphaned)
	}
}
