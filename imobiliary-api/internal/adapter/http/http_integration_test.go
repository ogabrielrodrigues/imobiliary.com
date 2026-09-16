//go:build integration

package http_test

import (
	"context"
	"crypto/rand"
	json "encoding/json/v2"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"uuid"

	adapterhttp "imobiliary/internal/adapter/http"
	"imobiliary/internal/adapter/postgres"
	"imobiliary/internal/adapter/sealing"
	"imobiliary/internal/domain"
	"imobiliary/internal/platform/fieldcrypt"
	"imobiliary/internal/platform/metrics"
	"imobiliary/internal/platform/password"
	"imobiliary/internal/platform/pgtest"
	"imobiliary/internal/platform/ratelimit"
	"imobiliary/internal/platform/token"
	"imobiliary/internal/platform/totp"
	"imobiliary/internal/usecase"
)

// The API exercised the way a client uses it: over HTTP, against a real
// PostgreSQL, with real argon2 hashing and real signatures. Nothing here
// reaches into a repository to arrange a state that a request could not
// produce, so a test passing means the sequence of calls behind it works.

const testPassword = "uma senha bem longa"

// letterbox is the mailer, keeping what was sent so a test can open the link
// the way a person opens their inbox.
type letterbox struct {
	mu       sync.Mutex
	messages []message
}

type message struct{ To, Subject, Body string }

func (l *letterbox) Send(_ context.Context, to, subject, body string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.messages = append(l.messages, message{to, subject, body})
	return nil
}

// last returns the newest message sent to an address.
func (l *letterbox) last(t *testing.T, to string) message {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := len(l.messages) - 1; i >= 0; i-- {
		if l.messages[i].To == to {
			return l.messages[i]
		}
	}
	t.Fatalf("no message was sent to %s", to)
	return message{}
}

func (l *letterbox) countTo(to string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := 0
	for _, m := range l.messages {
		if m.To == to {
			n++
		}
	}
	return n
}

// linkToken pulls the secret out of a link in a message body.
func linkToken(t *testing.T, body string) string {
	t.Helper()
	_, after, found := strings.Cut(body, "token=")
	if !found {
		t.Fatalf("no link with a token in:\n%s", body)
	}
	token, _, _ := strings.Cut(after, "\n")
	return strings.TrimSpace(token)
}

type api struct {
	t         *testing.T
	server    *httptest.Server
	mail      *letterbox
	db        *postgres.DB
	appURL    string
	totpSteps func() int64
}

func newAPI(t *testing.T) *api {
	t.Helper()

	db, err := postgres.Open(t.Context(), pgtest.NewDatabase(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)

	keys := map[byte][]byte{1: randomBytes(t, fieldcrypt.KeySize)}
	keyring, err := fieldcrypt.New(keys, randomBytes(t, fieldcrypt.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	signer, err := token.NewSigner(
		map[string][]byte{"1": randomBytes(t, token.KeySize)}, "1", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	repos := db.Repositories()
	hasher := password.NewHasher()
	box := &letterbox{}

	identity := usecase.NewIdentity(usecase.IdentityConfig{
		Repositories: repos, Transactor: db, Hasher: hasher, Tokens: signer,
		Mailer: box, RefreshTTL: 30 * 24 * time.Hour, Logger: logger,
	})
	sealer := sealing.New(keyring)
	mfa := usecase.NewMFA(usecase.MFAConfig{
		Identity: identity, Repositories: repos, Sealer: sealer, Logger: logger,
	})
	people := usecase.NewPeople(usecase.PeopleConfig{Scope: db, Sealer: sealer, Logger: logger})
	properties := usecase.NewProperties(usecase.PropertiesConfig{Scope: db, Logger: logger})
	privacy := usecase.NewPrivacy(usecase.PrivacyConfig{
		Identity: identity, Repositories: repos, Hasher: hasher, Sealer: sealer, Mailer: box, Logger: logger,
	})
	passwords := usecase.NewPasswords(usecase.PasswordsConfig{
		Identity: identity, Repositories: repos, Hasher: hasher, Mailer: box,
		AppURL: "https://imobiliary.test", ResetTTL: 30 * time.Minute, Logger: logger,
	})
	organizations := usecase.NewOrganizations(usecase.OrganizationsConfig{
		Identity: identity, Repositories: repos, Hasher: hasher, Mailer: box,
		AppURL: "https://imobiliary.test", InvitationTTL: 7 * 24 * time.Hour, Logger: logger,
	})

	// The limits are real but generous: what they do is covered by their own
	// test, and a suite that ran into them would fail for the wrong reason.
	limiter := func() *ratelimit.Limiter { return ratelimit.New(1000, 1000) }
	limiters := adapterhttp.Limiters{Global: limiter(), Credentials: limiter(), Write: limiter()}
	t.Cleanup(func() {
		limiters.Global.Close()
		limiters.Credentials.Close()
		limiters.Write.Close()
	})

	server := httptest.NewServer(adapterhttp.NewServer(adapterhttp.Options{
		Identity: identity, MFA: mfa, Passwords: passwords, Organizations: organizations,
		Privacy: privacy, People: people, Properties: properties,
		Auditor: usecase.NewAuditor(repos.Audit, time.Now, logger),
		Signer:  signer, Logger: logger, Metrics: metrics.NewRegistry(),
		Ready:    func(context.Context) error { return nil },
		Limiters: limiters, MaxRequestBytes: 1 << 20,
	}).Handler())
	t.Cleanup(server.Close)

	return &api{t: t, server: server, mail: box, db: db, appURL: "https://imobiliary.test"}
}

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// --- the request helpers ----------------------------------------------------

type response struct {
	status int
	body   []byte
	header http.Header
}

func (r response) decode(t *testing.T, dst any) {
	t.Helper()
	if err := json.Unmarshal(r.body, dst); err != nil {
		t.Fatalf("could not read the response %s: %v", r.body, err)
	}
}

func (r response) field(t *testing.T, path string) string {
	t.Helper()
	var value map[string]any
	r.decode(t, &value)
	current := any(value)
	for _, key := range strings.Split(path, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("%s is not an object in %s", key, r.body)
		}
		current = object[key]
	}
	text, ok := current.(string)
	if !ok {
		t.Fatalf("%s is not a string in %s", path, r.body)
	}
	return text
}

func (a *api) do(method, path, accessToken string, body any) response {
	a.t.Helper()

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			a.t.Fatal(err)
		}
		reader = strings.NewReader(string(encoded))
	}
	req, err := http.NewRequestWithContext(a.t.Context(), method, a.server.URL+path, reader)
	if err != nil {
		a.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}

	resp, err := a.server.Client().Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		a.t.Fatal(err)
	}
	return response{status: resp.StatusCode, body: payload, header: resp.Header}
}

func (a *api) expect(want int, method, path, accessToken string, body any) response {
	a.t.Helper()
	got := a.do(method, path, accessToken, body)
	if got.status != want {
		a.t.Fatalf("%s %s = %d, want %d: %s", method, path, got.status, want, got.body)
	}
	return got
}

// --- the flows --------------------------------------------------------------

// account is a signed-in person, as a test uses them.
type account struct {
	email    string
	password string
	access   string
	refresh  string
	userID   string
	secret   string // the TOTP secret, once enrolled
	recovery []string
}

// register opens an account with its office and signs in.
func (a *api) register(email, name, organization string) *account {
	a.t.Helper()
	a.expect(http.StatusAccepted, http.MethodPost, "/v1/accounts", "", map[string]any{
		"email": email, "name": name, "password": testPassword,
		"organization_name": organization, "terms_version": "1.0",
	})
	return a.signIn(email, testPassword)
}

func (a *api) signIn(email, pass string) *account {
	a.t.Helper()
	resp := a.expect(http.StatusOK, http.MethodPost, "/v1/sessions", "", map[string]any{
		"email": email, "password": pass,
	})
	var body struct {
		MFARequired bool `json:"mfa_required"`
		Session     struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			User         struct {
				ID string `json:"id"`
			} `json:"user"`
		} `json:"session"`
	}
	resp.decode(a.t, &body)
	if body.MFARequired {
		a.t.Fatalf("%s was asked for a second factor; use signInWithCode", email)
	}
	return &account{
		email: email, password: pass,
		access: body.Session.AccessToken, refresh: body.Session.RefreshToken,
		userID: body.Session.User.ID,
	}
}

// enrollTOTP turns on the second factor and keeps the secret and codes.
func (a *api) enrollTOTP(acc *account) {
	a.t.Helper()
	enrollment := a.expect(http.StatusOK, http.MethodPost, "/v1/me/totp", acc.access, map[string]any{})
	acc.secret = enrollment.field(a.t, "secret")

	code, err := totp.Code(acc.secret, totp.Step(time.Now()))
	if err != nil {
		a.t.Fatal(err)
	}
	confirmed := a.expect(http.StatusOK, http.MethodPost, "/v1/me/totp/confirm", acc.access,
		map[string]any{"code": code})
	var body struct {
		RecoveryCodes []string `json:"recovery_codes"`
	}
	confirmed.decode(a.t, &body)
	acc.recovery = body.RecoveryCodes
}

func TestRegistrationSignInAndTheEnrollmentRule(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana Souza", "Imobiliária Central")

	// An administrator without a second factor holds a real session that may
	// only enrol one.
	forbidden := a.expect(http.StatusForbidden, http.MethodGet, "/v1/me", admin.access, nil)
	if code := forbidden.field(t, "error.code"); code != "mfa_enrollment_required" {
		t.Fatalf("error code = %q", code)
	}
	a.expect(http.StatusForbidden, http.MethodGet, "/v1/organization/members", admin.access, nil)

	a.enrollTOTP(admin)
	if len(admin.recovery) != domain.RecoveryCodeCount {
		t.Fatalf("got %d recovery codes", len(admin.recovery))
	}

	me := a.expect(http.StatusOK, http.MethodGet, "/v1/me", admin.access, nil)
	var body struct {
		User struct {
			Name        string `json:"name"`
			TOTPEnabled bool   `json:"totp_enabled"`
		} `json:"user"`
		Role         domain.Role `json:"role"`
		Organization struct {
			Name string `json:"name"`
		} `json:"organization"`
		MFAEnrollmentRequired bool `json:"mfa_enrollment_required"`
		RecoveryCodesLeft     int  `json:"recovery_codes_left"`
	}
	me.decode(t, &body)
	if !body.User.TOTPEnabled || body.Role != domain.RoleAdmin || body.MFAEnrollmentRequired ||
		body.RecoveryCodesLeft != domain.RecoveryCodeCount || body.Organization.Name != "Imobiliária Central" {
		t.Fatalf("/v1/me = %+v", body)
	}

	// An administrator may not remove the factor that guards the account which
	// manages members.
	a.expect(http.StatusForbidden, http.MethodDelete, "/v1/me/totp", admin.access,
		map[string]any{"password": testPassword})
}

func TestRegistrationDoesNotRevealWhoHasAnAccount(t *testing.T) {
	a := newAPI(t)
	a.register("ana@example.com", "Ana", "Central")

	// The same answer for an address that is taken, and a message to the
	// owner instead.
	before := a.mail.countTo("ana@example.com")
	a.expect(http.StatusAccepted, http.MethodPost, "/v1/accounts", "", map[string]any{
		"email": "ana@example.com", "name": "Outra", "password": testPassword,
		"organization_name": "Outro escritório", "terms_version": "1.0",
	})
	if a.mail.countTo("ana@example.com") != before+1 {
		t.Fatal("the owner of the taken address was not told")
	}
	if subject := a.mail.last(t, "ana@example.com").Subject; !strings.Contains(subject, "Tentativa de cadastro") {
		t.Fatalf("the notice says %q", subject)
	}

	// And the office that the second attempt asked for does not exist.
	admin := a.signIn("ana@example.com", testPassword)
	a.enrollTOTP(admin)
	me := a.expect(http.StatusOK, http.MethodGet, "/v1/me", admin.access, nil)
	var body struct {
		Organizations []struct {
			Organization struct {
				Name string `json:"name"`
			} `json:"organization"`
		} `json:"organizations"`
	}
	me.decode(t, &body)
	if len(body.Organizations) != 1 {
		t.Fatalf("the account belongs to %d organisations", len(body.Organizations))
	}
}

func TestSecondFactorSignIn(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)

	// The password alone now earns a challenge and no session.
	resp := a.expect(http.StatusOK, http.MethodPost, "/v1/sessions", "", map[string]any{
		"email": admin.email, "password": testPassword,
	})
	var first struct {
		MFARequired bool      `json:"mfa_required"`
		Challenge   string    `json:"challenge"`
		Session     *struct{} `json:"session"`
	}
	resp.decode(t, &first)
	if !first.MFARequired || first.Session != nil || first.Challenge == "" {
		t.Fatalf("sign-in answered %+v", first)
	}

	// A wrong code spends the challenge: one challenge is one attempt.
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/mfa", "",
		map[string]any{"challenge": first.Challenge, "code": "000000"})

	resp = a.expect(http.StatusOK, http.MethodPost, "/v1/sessions", "", map[string]any{
		"email": admin.email, "password": testPassword,
	})
	resp.decode(t, &first)
	// The step of the code that confirmed the enrolment is recorded, so the
	// next code must belong to a later one. The next step is inside the skew
	// the verifier accepts, which is how this asks for a fresh code without
	// waiting thirty seconds for one.
	code, err := totp.Code(admin.secret, totp.Step(time.Now())+1)
	if err != nil {
		t.Fatal(err)
	}
	session := a.expect(http.StatusOK, http.MethodPost, "/v1/sessions/mfa", "",
		map[string]any{"challenge": first.Challenge, "code": code})
	if session.field(t, "organization.name") != "Central" {
		t.Fatalf("completed into %s", session.body)
	}

	// The challenge is spent, and so is the code.
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/mfa", "",
		map[string]any{"challenge": first.Challenge, "code": code})
}

func TestRecoveryCodeStandsInForTheApp(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)

	challenge := func() string {
		resp := a.expect(http.StatusOK, http.MethodPost, "/v1/sessions", "", map[string]any{
			"email": admin.email, "password": testPassword,
		})
		return resp.field(t, "challenge")
	}

	a.expect(http.StatusOK, http.MethodPost, "/v1/sessions/mfa", "",
		map[string]any{"challenge": challenge(), "code": admin.recovery[0]})

	// Once used, that code is gone.
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/mfa", "",
		map[string]any{"challenge": challenge(), "code": admin.recovery[0]})

	// A second code still works, and the count the settings screen shows has
	// gone down by one.
	a.expect(http.StatusOK, http.MethodPost, "/v1/sessions/mfa", "",
		map[string]any{"challenge": challenge(), "code": admin.recovery[1]})
}

func TestInvitationBringsSomeoneIn(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)

	invited := "carla@example.com"
	a.expect(http.StatusCreated, http.MethodPost, "/v1/organization/invitations", admin.access,
		map[string]any{"email": invited, "role": "member"})
	// The same address again is refused rather than answered with a second
	// link whose predecessor's fate nobody could explain.
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/organization/invitations", admin.access,
		map[string]any{"email": invited, "role": "member"})

	token := linkToken(t, a.mail.last(t, invited).Body)
	lookup := a.expect(http.StatusOK, http.MethodPost, "/v1/invitations/lookup", "",
		map[string]any{"token": token})
	if lookup.field(t, "organization.name") != "Central" || lookup.field(t, "email") != invited {
		t.Fatalf("lookup = %s", lookup.body)
	}

	a.expect(http.StatusNoContent, http.MethodPost, "/v1/invitations/accept", "", map[string]any{
		"token": token, "name": "Carla Dias", "password": testPassword, "terms_version": "1.0",
	})
	// A link opened twice joins once.
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/invitations/accept", "", map[string]any{
		"token": token, "name": "Carla Dias", "password": testPassword, "terms_version": "1.0",
	})

	// A member signs in without a second factor of their own, sees the office,
	// and may not manage it.
	member := a.signIn(invited, testPassword)
	a.expect(http.StatusOK, http.MethodGet, "/v1/organization/members", member.access, nil)
	a.expect(http.StatusForbidden, http.MethodPost, "/v1/organization/invitations", member.access,
		map[string]any{"email": "x@example.com", "role": "member"})
	a.expect(http.StatusForbidden, http.MethodPatch, "/v1/organization", member.access,
		map[string]any{"name": "Outro nome"})

	members := a.expect(http.StatusOK, http.MethodGet, "/v1/organization/members", admin.access, nil)
	var list struct {
		Members []struct {
			User struct{ ID, Name string } `json:"user"`
			Role domain.Role               `json:"role"`
		} `json:"members"`
	}
	members.decode(t, &list)
	if len(list.Members) != 2 {
		t.Fatalf("the office has %d members", len(list.Members))
	}
}

func TestRolesAndTheLastAdministrator(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)
	member := a.invite(admin, "carla@example.com")

	// The only administrator cannot step down, and cannot remove themselves.
	demote := a.expect(http.StatusUnprocessableEntity, http.MethodPatch,
		"/v1/organization/members/"+admin.userID, admin.access, map[string]any{"role": "member"})
	if !strings.Contains(string(demote.body), "administrator") {
		t.Fatalf("the refusal says %s", demote.body)
	}
	a.expect(http.StatusConflict, http.MethodDelete,
		"/v1/organization/members/"+admin.userID, admin.access, nil)

	// With a second administrator, the first may step down.
	a.expect(http.StatusNoContent, http.MethodPatch,
		"/v1/organization/members/"+member.userID, admin.access, map[string]any{"role": "admin"})
	a.expect(http.StatusNoContent, http.MethodPatch,
		"/v1/organization/members/"+admin.userID, admin.access, map[string]any{"role": "member"})

	// And the demotion takes effect on the session already open, because the
	// membership is read on every request rather than trusted from the token.
	a.expect(http.StatusForbidden, http.MethodPost, "/v1/organization/invitations", admin.access,
		map[string]any{"email": "outro@example.com", "role": "member"})
}

// invite runs the whole invitation for a test that needs a second person.
func (a *api) invite(admin *account, email string) *account {
	a.t.Helper()
	a.expect(http.StatusCreated, http.MethodPost, "/v1/organization/invitations", admin.access,
		map[string]any{"email": email, "role": "member"})
	token := linkToken(a.t, a.mail.last(a.t, email).Body)
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/invitations/accept", "", map[string]any{
		"token": token, "name": "Carla Dias", "password": testPassword, "terms_version": "1.0",
	})
	return a.signIn(email, testPassword)
}

func TestRemovingAMemberEndsTheirSessions(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)
	member := a.invite(admin, "carla@example.com")

	a.expect(http.StatusOK, http.MethodGet, "/v1/me", member.access, nil)
	a.expect(http.StatusNoContent, http.MethodDelete,
		"/v1/organization/members/"+member.userID, admin.access, nil)

	// The access token is refused at once, because the membership behind it is
	// gone, and the refresh token no longer opens a new session.
	a.expect(http.StatusForbidden, http.MethodGet, "/v1/me", member.access, nil)
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/refresh", "",
		map[string]any{"refresh_token": member.refresh})
	// Signing in again gets nowhere: the account belongs to no office.
	a.expect(http.StatusForbidden, http.MethodPost, "/v1/sessions", "",
		map[string]any{"email": member.email, "password": testPassword})
}

func TestRefreshRotatesAndAReplayEndsTheChain(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)
	member := a.invite(admin, "carla@example.com")

	rotated := a.expect(http.StatusOK, http.MethodPost, "/v1/sessions/refresh", "",
		map[string]any{"refresh_token": member.refresh})
	next := rotated.field(t, "refresh_token")
	if next == member.refresh {
		t.Fatal("the refresh token was not rotated")
	}

	// Presenting the consumed one is a replay, and revokes the whole chain.
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/refresh", "",
		map[string]any{"refresh_token": member.refresh})
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/refresh", "",
		map[string]any{"refresh_token": next})
}

func TestConcurrentRefreshExchangesTheSecretOnce(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)
	member := a.invite(admin, "carla@example.com")

	const attempts = 6
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		granted int
	)
	for range attempts {
		wg.Go(func() {
			resp := a.do(http.MethodPost, "/v1/sessions/refresh", "",
				map[string]any{"refresh_token": member.refresh})
			mu.Lock()
			defer mu.Unlock()
			if resp.status == http.StatusOK {
				granted++
			}
		})
	}
	wg.Wait()

	if granted != 1 {
		t.Fatalf("%d of %d concurrent refreshes succeeded, want exactly 1", granted, attempts)
	}
}

func TestPasswordChangeAndRecovery(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)
	member := a.invite(admin, "carla@example.com")

	// A JWT issue time carries whole seconds, so the comparison against
	// password_changed_at is truncated to the second and a token minted in the
	// same second as the change survives it. That is a known, documented
	// window; crossing a second boundary here is what makes the test about the
	// rule rather than about the rounding.
	time.Sleep(1100 * time.Millisecond)

	// Changing a password ends every session, this one included.
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/me/password", member.access,
		map[string]any{"current_password": testPassword, "new_password": "curta"})
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/me/password", member.access,
		map[string]any{"current_password": "a senha errada aqui", "new_password": "outra senha bem longa"})
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/me/password", member.access,
		map[string]any{"current_password": testPassword, "new_password": "outra senha bem longa"})

	// The access token minted before the change is refused, even though it has
	// not expired: this is what password_changed_at is for.
	a.expect(http.StatusUnauthorized, http.MethodGet, "/v1/me", member.access, nil)
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/refresh", "",
		map[string]any{"refresh_token": member.refresh})
	a.signIn(member.email, "outra senha bem longa")

	// Recovery answers the same for an address with an account and one
	// without, and only the first gets a message.
	before := len(a.mail.messages)
	a.expect(http.StatusAccepted, http.MethodPost, "/v1/password/forgot", "",
		map[string]any{"email": "ninguem@example.com"})
	if len(a.mail.messages) != before {
		t.Fatal("an unknown address received a message")
	}
	a.expect(http.StatusAccepted, http.MethodPost, "/v1/password/forgot", "",
		map[string]any{"email": member.email})

	token := linkToken(t, a.mail.last(t, member.email).Body)
	a.expect(http.StatusUnprocessableEntity, http.MethodPost, "/v1/password/reset", "",
		map[string]any{"token": token, "password": "curta"})
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/password/reset", "",
		map[string]any{"token": token, "password": "mais uma senha longa"})
	// One link, one reset.
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/password/reset", "",
		map[string]any{"token": token, "password": "e mais outra senha longa"})

	a.signIn(member.email, "mais uma senha longa")
}

func TestOfficesAreIsolated(t *testing.T) {
	a := newAPI(t)
	first := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(first)
	second := a.register("bruno@example.com", "Bruno", "Lima Imóveis")
	a.enrollTOTP(second)

	// The member list of one office names nobody from the other.
	members := a.expect(http.StatusOK, http.MethodGet, "/v1/organization/members", first.access, nil)
	if strings.Contains(string(members.body), "bruno@example.com") {
		t.Fatalf("one office sees another's members: %s", members.body)
	}

	// An invitation of one office cannot be revoked by the other's
	// administrator, even with its identifier.
	created := a.expect(http.StatusCreated, http.MethodPost, "/v1/organization/invitations",
		first.access, map[string]any{"email": "carla@example.com", "role": "member"})
	id := created.field(t, "id")
	a.expect(http.StatusNotFound, http.MethodDelete, "/v1/organization/invitations/"+id,
		second.access, nil)
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/organization/invitations/"+id,
		first.access, nil)
}

func TestTheAuditTrailIsWrittenAndCannotBeRewritten(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)

	var actions []string
	rows, err := a.db.QueryForTest(t.Context(),
		`SELECT action FROM audit_events ORDER BY occurred_at`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var action string
		if err := rows.Scan(&action); err != nil {
			t.Fatal(err)
		}
		actions = append(actions, action)
	}
	rows.Close()

	for _, want := range []domain.AuditAction{
		domain.ActionOrganizationCreated, domain.ActionUserRegistered, domain.ActionTOTPEnabled,
	} {
		if !contains(actions, string(want)) {
			t.Errorf("the trail has no %s: %v", want, actions)
		}
	}

	// An audit row carries no secret and no personal value, only names.
	var fields []string
	if err := a.db.QueryRowForTest(t.Context(),
		`SELECT fields FROM audit_events WHERE action = $1`, string(domain.ActionUserRegistered),
	).Scan(&fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 0 {
		t.Errorf("registration recorded fields %v", fields)
	}
}

func contains(haystack []string, needle string) bool {
	for _, item := range haystack {
		if item == needle {
			return true
		}
	}
	return false
}

func TestAccessRecordsAreKeptForTheMarcoCivil(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)

	// A refused attempt and an accepted one are both recorded, with the
	// address they came from.
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions", "",
		map[string]any{"email": admin.email, "password": "a senha errada aqui"})

	var signIns, refusals int
	if err := a.db.QueryRowForTest(t.Context(),
		`SELECT count(*) FILTER (WHERE event = 'sign_in'),
		        count(*) FILTER (WHERE event = 'sign_in_refused')
		   FROM access_records WHERE ip IS NOT NULL`,
	).Scan(&signIns, &refusals); err != nil {
		t.Fatal(err)
	}
	if signIns == 0 || refusals == 0 {
		t.Fatalf("access records: %d sign-ins, %d refusals", signIns, refusals)
	}
}

func TestUnknownAndMalformedRequests(t *testing.T) {
	a := newAPI(t)

	a.expect(http.StatusNotFound, http.MethodGet, "/v1/nothing-here", "", nil)
	a.expect(http.StatusUnauthorized, http.MethodGet, "/v1/me", "", nil)
	a.expect(http.StatusUnauthorized, http.MethodGet, "/v1/me", "not-a-token", nil)

	// A body that is not JSON, and one sent without the content type.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
		a.server.URL+"/v1/sessions", strings.NewReader("{"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("a malformed body = %d", resp.StatusCode)
	}

	req, err = http.NewRequestWithContext(t.Context(), http.MethodPost,
		a.server.URL+"/v1/sessions", strings.NewReader(`{"email":"a@b.c","password":"x"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp, err = a.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("a body without a content type = %d", resp.StatusCode)
	}
}

func TestSwitchingBetweenOffices(t *testing.T) {
	a := newAPI(t)
	first := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(first)
	other := a.register("bruno@example.com", "Bruno", "Lima Imóveis")
	a.enrollTOTP(other)

	// Ana is invited into Bruno's office as well.
	a.expect(http.StatusCreated, http.MethodPost, "/v1/organization/invitations", other.access,
		map[string]any{"email": first.email, "role": "member"})
	token := linkToken(t, a.mail.last(t, first.email).Body)
	a.expect(http.StatusNoContent, http.MethodPost, "/v1/invitations/accept", "",
		map[string]any{"token": token})

	me := a.expect(http.StatusOK, http.MethodGet, "/v1/me", first.access, nil)
	var body struct {
		Organizations []struct {
			Organization struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"organization"`
			Role domain.Role `json:"role"`
		} `json:"organizations"`
	}
	me.decode(t, &body)
	if len(body.Organizations) != 2 {
		t.Fatalf("Ana belongs to %d offices", len(body.Organizations))
	}

	var target string
	for _, m := range body.Organizations {
		if m.Organization.Name == "Lima Imóveis" {
			target = m.Organization.ID
		}
	}
	switched := a.expect(http.StatusOK, http.MethodPost, "/v1/sessions/switch", "",
		map[string]any{"refresh_token": first.refresh, "organization_id": target})
	if switched.field(t, "organization.name") != "Lima Imóveis" || switched.field(t, "role") != "member" {
		t.Fatalf("switched into %s", switched.body)
	}

	// An office she does not belong to is refused.
	a.expect(http.StatusForbidden, http.MethodPost, "/v1/sessions/switch", "",
		map[string]any{
			"refresh_token":   switched.field(t, "refresh_token"),
			"organization_id": uuid.NewV7().String(),
		})
}

func TestSignOutEndsTheSession(t *testing.T) {
	a := newAPI(t)
	admin := a.register("ana@example.com", "Ana", "Central")
	a.enrollTOTP(admin)

	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/sessions", "",
		map[string]any{"refresh_token": admin.refresh})
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/refresh", "",
		map[string]any{"refresh_token": admin.refresh})
	// Signing out twice, or with a secret that was never one, is not an error:
	// the caller wanted the session gone and it is.
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/sessions", "",
		map[string]any{"refresh_token": admin.refresh})
	a.expect(http.StatusNoContent, http.MethodDelete, "/v1/sessions", "",
		map[string]any{"refresh_token": "never-was-a-token"})
}
