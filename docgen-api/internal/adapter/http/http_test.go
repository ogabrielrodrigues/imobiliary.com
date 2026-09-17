//go:build integration

package http_test

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	json "encoding/json/v2"
	"io"
	"io/fs"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"uuid"

	adapterhttp "docgen/internal/adapter/http"
	"docgen/internal/adapter/sqlite"
	"docgen/internal/platform/blob"
	"docgen/internal/platform/ratelimit"
	"docgen/internal/platform/token"
	"docgen/internal/usecase"

	"github.com/golang-jwt/jwt/v5"
)

// testServer is a fully wired service in front of a throwaway database.
type testServer struct {
	*httptest.Server
	t *testing.T
	// blobDir lets a test confirm that erasure reached the filesystem, which
	// is the half of it a database assertion cannot see.
	blobDir string
	// dbPath lets a test put rows the API cannot create any more, such as an
	// account from before identity moved to the platform.
	dbPath string
	// signingKey signs tokens the way the Imobiliary platform does.
	signingKey ed25519.PrivateKey
}

func (s *testServer) storedBlobs() int {
	s.t.Helper()

	count := 0
	err := filepath.WalkDir(s.blobDir, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			count++
		}
		return nil
	})
	if err != nil {
		s.t.Fatalf("walk blob directory: %v", err)
	}
	return count
}

type serverOptions struct {
	globalRate, authRate, writeRate    float64
	globalBurst, authBurst, writeBurst int
}

// testLogger stays silent unless DOCGEN_TEST_LOG is set, which is how a
// failing handler can be made to explain itself.
func testLogger() *slog.Logger {
	if os.Getenv("DOCGEN_TEST_LOG") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	return slog.New(slog.DiscardHandler)
}

func defaultServerOptions() serverOptions {
	return serverOptions{
		globalRate: 1000, globalBurst: 1000,
		authRate: 1000, authBurst: 1000,
		writeRate: 1000, writeBurst: 1000,
	}
}

func newTestServer(t *testing.T, opts serverOptions) *testServer {
	t.Helper()

	dir := t.TempDir()

	db, err := sqlite.Open(t.Context(), filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	blobs, err := blob.New(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatalf("open blob store: %v", err)
	}

	templatesRepo := sqlite.NewTemplateRepository(db)
	batchesRepo := sqlite.NewBatchRepository(db)
	documentsRepo := sqlite.NewDocumentRepository(db)
	cache := usecase.NewTemplateCache(16)

	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := token.NewVerifier(map[string]ed25519.PublicKey{"1": public})
	if err != nil {
		t.Fatal(err)
	}
	access := usecase.NewAccess(usecase.AccessConfig{
		Verifier: verifier,
		Owners:   sqlite.NewOwnerRepository(db),
		Logger:   testLogger(),
	})
	templates := usecase.NewTemplates(usecase.TemplatesConfig{
		Repo:      templatesRepo,
		Blobs:     blobs,
		Cache:     cache,
		MaxUpload: 10 << 20,
	})
	documents := usecase.NewDocuments(usecase.DocumentsConfig{
		Templates: templatesRepo,
		Documents: documentsRepo,
		Batches:   batchesRepo,
		Blobs:     blobs,
		Cache:     cache,
	})

	privacy := usecase.NewPrivacy(usecase.PrivacyConfig{
		Owners:    sqlite.NewOwnerRepository(db),
		Templates: templatesRepo,
		Documents: documentsRepo,
		Batches:   batchesRepo,
		Blobs:     blobs,
		Logger:    testLogger(),
	})

	limiters := adapterhttp.Limiters{
		Global: ratelimit.New(opts.globalRate, opts.globalBurst),
		Write:  ratelimit.New(opts.writeRate, opts.writeBurst),
	}
	t.Cleanup(func() {
		limiters.Global.Close()
		limiters.Write.Close()
	})

	server := adapterhttp.NewServer(adapterhttp.Options{
		Access:    access,
		Templates: templates,
		Documents: documents,
		Privacy:   privacy,
		Stats:     usecase.NewStats(usecase.StatsConfig{Repo: sqlite.NewStatsRepository(db)}),
		Batches: usecase.NewBatches(usecase.BatchesConfig{
			Templates: templatesRepo,
			Batches:   batchesRepo,
			Documents: documentsRepo,
			Blobs:     blobs,
		}),
		Limiters:        limiters,
		Logger:          testLogger(),
		Health:          db.Ping,
		MaxRequestBytes: 1 << 20,
		MaxUploadBytes:  10 << 20,
	})

	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(httpServer.Close)

	return &testServer{Server: httpServer, t: t, blobDir: filepath.Join(dir, "blobs"), dbPath: filepath.Join(dir, "test.db"), signingKey: private}
}

// do sends a request and returns the response.
func (s *testServer) do(req *http.Request) *http.Response {
	s.t.Helper()

	resp, err := s.Client().Do(req)
	if err != nil {
		s.t.Fatalf("%s %s: %v", req.Method, req.URL.Path, err)
	}
	return resp
}

// postJSON sends a JSON body, optionally authenticated.
func (s *testServer) postJSON(path, accessToken string, body any) *http.Response {
	s.t.Helper()

	encoded, err := json.Marshal(body)
	if err != nil {
		s.t.Fatalf("encode request body: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, s.URL+path, bytes.NewReader(encoded))
	if err != nil {
		s.t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	return s.do(req)
}

// get sends an authenticated GET.
func (s *testServer) get(path, accessToken string) *http.Response {
	s.t.Helper()

	req, err := http.NewRequest(http.MethodGet, s.URL+path, nil)
	if err != nil {
		s.t.Fatalf("build request: %v", err)
	}
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	return s.do(req)
}

// delete sends an authenticated DELETE.
func (s *testServer) delete(path, accessToken string) *http.Response {
	s.t.Helper()

	req, err := http.NewRequest(http.MethodDelete, s.URL+path, nil)
	if err != nil {
		s.t.Fatalf("build request: %v", err)
	}
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	return s.do(req)
}

// uploadTemplate posts a multipart template upload.
func (s *testServer) uploadTemplate(path, accessToken, name string, archive []byte) *http.Response {
	s.t.Helper()

	var body bytes.Buffer
	form := multipart.NewWriter(&body)

	if name != "" {
		if err := form.WriteField("name", name); err != nil {
			s.t.Fatalf("write form field: %v", err)
		}
	}
	part, err := form.CreateFormFile("file", "template.docx")
	if err != nil {
		s.t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write(archive); err != nil {
		s.t.Fatalf("write form file: %v", err)
	}
	if err := form.Close(); err != nil {
		s.t.Fatalf("close form: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, s.URL+path, &body)
	if err != nil {
		s.t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+accessToken)
	return s.do(req)
}

// decode reads a JSON response body into dst and checks the status code.
func decode(t *testing.T, resp *http.Response, wantStatus int, dst any) {
	t.Helper()
	defer resp.Body.Close()

	if resp.StatusCode != wantStatus {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want %d; body: %s", resp.StatusCode, wantStatus, body)
	}
	if dst == nil {
		return
	}
	if err := json.UnmarshalRead(resp.Body, dst); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

// expectStatus asserts a status code and discards the body.
func expectStatus(t *testing.T, resp *http.Response, want int) {
	t.Helper()
	defer resp.Body.Close()

	if resp.StatusCode != want {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want %d; body: %s", resp.StatusCode, want, body)
	}
}

// Response shapes, mirroring what the handlers produce.
type sessionBody struct {
	AccessToken string
}

type templateBody struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	LatestVersion int    `json:"latest_version"`
	Version       *struct {
		Version      int      `json:"version"`
		Placeholders []string `json:"placeholders"`
	} `json:"version"`
}

type versionsBody struct {
	Items []struct {
		Version      int      `json:"version"`
		Size         int64    `json:"size"`
		Placeholders []string `json:"placeholders"`
	} `json:"items"`
}

type documentBody struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	Size        int64  `json:"size"`
	DownloadURL string `json:"download_url"`
}

type errorBody struct {
	Error struct {
		Code   string `json:"code"`
		Fields []struct {
			Field   string `json:"field"`
			Message string `json:"message"`
		} `json:"fields"`
	} `json:"error"`
}

// registerAndLogin returns a token for a new office whose member has this
// e-mail, signed the way the Imobiliary platform signs them. Each call is a
// different office, which is what the isolation tests rely on.
func (s *testServer) registerAndLogin(email string) sessionBody {
	s.t.Helper()
	return sessionBody{AccessToken: s.tokenFor(uuid.NewV7(), email, "Escritório de "+email)}
}

// tokenFor signs a token for a member of an office.
func (s *testServer) tokenFor(office uuid.UUID, email, officeName string) string {
	s.t.Helper()
	now := time.Now()
	claims := token.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: token.Issuer, Subject: uuid.NewV7().String(), Audience: jwt.ClaimStrings{token.Audience},
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(5 * time.Minute)),
		},
		Organization: office.String(), OrganizationName: officeName, Email: email, Name: "Membro", Role: "member",
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = "1"
	raw, err := tok.SignedString(s.signingKey)
	if err != nil {
		s.t.Fatal(err)
	}
	return raw
}

// buildDOCX assembles a minimal archive whose paragraph is split across runs,
// the way Word actually stores an edited document.
func buildDOCX(t *testing.T, texts ...string) []byte {
	t.Helper()

	var paragraph strings.Builder
	paragraph.WriteString("<w:p>")
	for _, text := range texts {
		paragraph.WriteString(`<w:r><w:t xml:space="preserve">`)
		paragraph.WriteString(text)
		paragraph.WriteString(`</w:t></w:r>`)
	}
	paragraph.WriteString("</w:p>")

	document := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>` + paragraph.String() + `</w:body>
</w:document>`

	parts := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
		"word/document.xml": document,
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels", "word/document.xml"} {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create entry %q: %v", name, err)
		}
		if _, err := io.WriteString(w, parts[name]); err != nil {
			t.Fatalf("write entry %q: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close archive: %v", err)
	}
	return buf.Bytes()
}

// documentText pulls the text of a rendered DOCX back out.
func documentText(t *testing.T, archive []byte) string {
	t.Helper()

	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("the downloaded file is not a valid archive: %v", err)
	}
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open document part: %v", err)
		}
		defer rc.Close()

		data, err := io.ReadAll(rc)
		if err != nil {
			t.Fatalf("read document part: %v", err)
		}
		return string(data)
	}
	t.Fatal("the downloaded archive has no word/document.xml")
	return ""
}

// TestFullDocumentLifecycle walks the whole product: create an account,
// authenticate, upload a template, discover its schema, generate a document and
// download it, then confirm the result is a valid DOCX carrying the data.
func TestFullDocumentLifecycle(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("lifecycle@example.com")

	// The placeholder is deliberately split across runs in the upload.
	archive := buildDOCX(t, "Dear {{", ".customer", "_name}}, your plan is {{.plan}}.")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Welcome letter", archive),
		http.StatusCreated, &created)

	if created.LatestVersion != 1 {
		t.Errorf("latest_version = %d, want 1", created.LatestVersion)
	}
	if created.Version == nil {
		t.Fatal("upload response carries no version")
	}

	// The schema must have been discovered automatically, with the split
	// placeholder reassembled.
	got := created.Version.Placeholders
	if len(got) != 2 || got[0] != "customer_name" || got[1] != "plan" {
		t.Fatalf("placeholders = %v, want [customer_name plan]", got)
	}

	// Fetching the template reports the same schema.
	var fetched templateBody
	decode(t, server.get("/v1/templates/"+created.ID, session.AccessToken), http.StatusOK, &fetched)
	if fetched.Version == nil || len(fetched.Version.Placeholders) != 2 {
		t.Errorf("GET template returned schema %+v", fetched.Version)
	}

	var document documentBody
	decode(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
		"template_id": created.ID,
		"filename":    "welcome letter.docx",
		"data": map[string]string{
			// A value with XML metacharacters, which a naive renderer would
			// use to produce a corrupt file.
			"customer_name": "Smith & Sons <Holdings>",
			"plan":          "Premium",
		},
	}), http.StatusCreated, &document)

	if document.Size == 0 {
		t.Error("generated document reports zero size")
	}

	resp := server.get(document.DownloadURL, session.AccessToken)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("download status = %d; body: %s", resp.StatusCode, body)
	}
	if contentType := resp.Header.Get("Content-Type"); !strings.Contains(contentType, "wordprocessingml") {
		t.Errorf("download Content-Type = %q", contentType)
	}
	if disposition := resp.Header.Get("Content-Disposition"); !strings.Contains(disposition, "attachment") {
		t.Errorf("download Content-Disposition = %q", disposition)
	}

	downloaded, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read downloaded document: %v", err)
	}

	text := documentText(t, downloaded)
	if !strings.Contains(text, "Premium") {
		t.Errorf("rendered document is missing the substituted plan:\n%s", text)
	}
	if !strings.Contains(text, "Smith &amp; Sons") {
		t.Errorf("the ampersand was not escaped in the output:\n%s", text)
	}
	if strings.Contains(text, "{{") {
		t.Errorf("the rendered document still contains a placeholder:\n%s", text)
	}
}

// TestGenerateRejectsDataThatDoesNotMatchTheSchema covers the validation that
// turns a typo into an itemised 422 instead of a silently incomplete document.
func TestGenerateRejectsDataThatDoesNotMatchTheSchema(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("schema@example.com")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Contract",
		buildDOCX(t, "Client {{.customer_name}} pays {{.amount}}")), http.StatusCreated, &created)

	t.Run("missing field", func(t *testing.T) {
		var failure errorBody
		decode(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
			"template_id": created.ID,
			"data":        map[string]string{"customer_name": "Ada"},
		}), http.StatusUnprocessableEntity, &failure)

		if failure.Error.Code != "validation_failed" {
			t.Errorf("error code = %q", failure.Error.Code)
		}
		if len(failure.Error.Fields) == 0 || !strings.Contains(failure.Error.Fields[0].Field, "amount") {
			t.Errorf("error does not name the missing field: %+v", failure.Error.Fields)
		}
	})

	t.Run("unknown field", func(t *testing.T) {
		var failure errorBody
		decode(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
			"template_id": created.ID,
			"data": map[string]string{
				"customer_name": "Ada",
				"amount":        "100",
				"custmer_email": "typo@example.com",
			},
		}), http.StatusUnprocessableEntity, &failure)

		if len(failure.Error.Fields) == 0 {
			t.Error("an unknown field was accepted silently")
		}
	})
}

func TestUploadRejectsSomethingThatIsNotADOCX(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("badupload@example.com")

	resp := server.uploadTemplate("/v1/templates", session.AccessToken, "Broken",
		[]byte("this is definitely not a zip archive"))
	expectStatus(t, resp, http.StatusUnprocessableEntity)
}

// TestProtectedRoutesRequireAuthentication checks the middleware, not the
// handlers: none of these should reach a use case at all.
func TestProtectedRoutesRequireAuthentication(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())

	tests := []struct {
		name  string
		token string
	}{
		{"no token", ""},
		{"garbage token", "not-a-real-token"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp := server.get("/v1/templates", tc.token)
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", resp.StatusCode)
			}
			if got := resp.Header.Get("WWW-Authenticate"); got != "Bearer" {
				t.Errorf("WWW-Authenticate = %q, want Bearer", got)
			}
		})
	}
}

// TestAccountsAreIsolated confirms that ownership is enforced, which is the
// property that keeps one customer's documents away from another's.
func TestAccountsAreIsolated(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	owner := server.registerAndLogin("owner@example.com")
	stranger := server.registerAndLogin("stranger@example.com")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", owner.AccessToken, "Private",
		buildDOCX(t, "Secret {{.value}}")), http.StatusCreated, &created)

	var document documentBody
	decode(t, server.postJSON("/v1/documents", owner.AccessToken, map[string]any{
		"template_id": created.ID,
		"data":        map[string]string{"value": "confidential"},
	}), http.StatusCreated, &document)

	t.Run("template is invisible", func(t *testing.T) {
		expectStatus(t, server.get("/v1/templates/"+created.ID, stranger.AccessToken), http.StatusNotFound)
	})

	t.Run("document is invisible", func(t *testing.T) {
		expectStatus(t, server.get("/v1/documents/"+document.ID, stranger.AccessToken), http.StatusNotFound)
	})

	t.Run("download is refused", func(t *testing.T) {
		expectStatus(t, server.get(document.DownloadURL, stranger.AccessToken), http.StatusNotFound)
	})

	t.Run("versions are invisible", func(t *testing.T) {
		// Not an empty list: an unknown template and someone else's template must
		// be indistinguishable, and must answer as Get does.
		expectStatus(t, server.get("/v1/templates/"+created.ID+"/versions", stranger.AccessToken), http.StatusNotFound)
	})

	t.Run("deleting another account's template is refused", func(t *testing.T) {
		expectStatus(t, server.delete("/v1/templates/"+created.ID, stranger.AccessToken), http.StatusNotFound)
	})

	t.Run("generating from another account's template is refused", func(t *testing.T) {
		expectStatus(t, server.postJSON("/v1/documents", stranger.AccessToken, map[string]any{
			"template_id": created.ID,
			"data":        map[string]string{"value": "stolen"},
		}), http.StatusNotFound)
	})
}

func TestHealthEndpointIsPublic(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())

	var body map[string]string
	decode(t, server.get("/healthz", ""), http.StatusOK, &body)

	if body["status"] != "ok" {
		t.Errorf("health body = %v", body)
	}
}

// TestTemplateVersioningOverHTTP confirms that publishing a new version leaves
// the previous one usable, which is what keeps existing documents reproducible.
func TestTemplateVersioningOverHTTP(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("versions@example.com")

	var v1 templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Evolving",
		buildDOCX(t, "Version one: {{.alpha}}")), http.StatusCreated, &v1)

	var v2 templateBody
	decode(t, server.uploadTemplate("/v1/templates/"+v1.ID+"/versions", session.AccessToken, "",
		buildDOCX(t, "Version two: {{.beta}}")), http.StatusCreated, &v2)

	if v2.Version == nil || v2.Version.Version != 2 {
		t.Fatalf("second upload produced version %+v, want 2", v2.Version)
	}

	// The latest version now expects a different field.
	expectStatus(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
		"template_id": v1.ID,
		"data":        map[string]string{"beta": "new"},
	}), http.StatusCreated)

	// Pinning version 1 still works, with the original schema.
	one := 1
	expectStatus(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
		"template_id": v1.ID,
		"version":     one,
		"data":        map[string]string{"alpha": "old"},
	}), http.StatusCreated)

	// Listing is what lets a client offer that choice: the version numbers are
	// guessable, but the schema behind each one is not.
	var listed versionsBody
	decode(t, server.get("/v1/templates/"+v1.ID+"/versions", session.AccessToken), http.StatusOK, &listed)

	if len(listed.Items) != 2 {
		t.Fatalf("listed %d versions, want 2", len(listed.Items))
	}
	if listed.Items[0].Version != 2 || listed.Items[1].Version != 1 {
		t.Errorf("versions listed %d then %d, want newest first",
			listed.Items[0].Version, listed.Items[1].Version)
	}
	if !slices.Equal(listed.Items[1].Placeholders, []string{"alpha"}) {
		t.Errorf("version 1 placeholders = %v, want [alpha]", listed.Items[1].Placeholders)
	}
	if !slices.Equal(listed.Items[0].Placeholders, []string{"beta"}) {
		t.Errorf("version 2 placeholders = %v, want [beta]", listed.Items[0].Placeholders)
	}
	if listed.Items[0].Size <= 0 {
		t.Errorf("version 2 reported size %d", listed.Items[0].Size)
	}

	expectStatus(t, server.get("/v1/templates/not-a-uuid/versions", session.AccessToken), http.StatusBadRequest)
}

// TestDeleteTemplateKeepsGeneratedDocuments covers the property the soft delete
// exists for: the template disappears, and the documents already generated from
// it stay downloadable, contents intact.
func TestDeleteTemplateKeepsGeneratedDocuments(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("deleting@example.com")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Doomed",
		buildDOCX(t, "Payable to {{.customer_name}}")), http.StatusCreated, &created)

	var document documentBody
	decode(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
		"template_id": created.ID,
		"data":        map[string]string{"customer_name": "Acme"},
	}), http.StatusCreated, &document)

	expectStatus(t, server.delete("/v1/templates/"+created.ID, session.AccessToken), http.StatusNoContent)

	// The template is gone from every route that reads one.
	expectStatus(t, server.get("/v1/templates/"+created.ID, session.AccessToken), http.StatusNotFound)
	expectStatus(t, server.get("/v1/templates/"+created.ID+"/versions", session.AccessToken), http.StatusNotFound)
	expectStatus(t, server.get("/v1/templates/"+created.ID+"/versions/1/file", session.AccessToken), http.StatusNotFound)

	var listed struct {
		Items []templateBody `json:"items"`
	}
	decode(t, server.get("/v1/templates", session.AccessToken), http.StatusOK, &listed)
	for _, item := range listed.Items {
		if item.ID == created.ID {
			t.Errorf("the deleted template is still listed")
		}
	}

	// Deleting twice is not a way to discover that something was there.
	expectStatus(t, server.delete("/v1/templates/"+created.ID, session.AccessToken), http.StatusNotFound)

	// And the document survives, still carrying the substituted value.
	resp := server.get(document.DownloadURL, session.AccessToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("downloading a document from a deleted template = %d, want 200", resp.StatusCode)
	}
	defer resp.Body.Close()
	archive, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read downloaded document: %v", err)
	}
	if text := documentText(t, archive); !strings.Contains(text, "Payable to Acme") {
		t.Errorf("the surviving document reads %q", text)
	}
}

// withExtraPart rebuilds an archive with one additional entry. It stands in for
// the source an authoring client embeds inside the templates it creates.
func withExtraPart(t *testing.T, archive []byte, name, content string) []byte {
	t.Helper()

	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range zr.File {
		if err := zw.Copy(f); err != nil {
			t.Fatalf("copy entry %q: %v", f.Name, err)
		}
	}

	w, err := zw.Create(name)
	if err != nil {
		t.Fatalf("create entry %q: %v", name, err)
	}
	if _, err := io.WriteString(w, content); err != nil {
		t.Fatalf("write entry %q: %v", name, err)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close archive: %v", err)
	}
	return buf.Bytes()
}

// archivePart returns one entry of an archive and whether it was present.
func archivePart(t *testing.T, archive []byte, name string) (string, bool) {
	t.Helper()

	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("the downloaded file is not a valid archive: %v", err)
	}
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open entry %q: %v", name, err)
		}
		defer rc.Close()

		data, err := io.ReadAll(rc)
		if err != nil {
			t.Fatalf("read entry %q: %v", name, err)
		}
		return string(data), true
	}
	return "", false
}

// downloadTemplateVersion fetches the stored archive of one template version.
func (s *testServer) downloadTemplateVersion(templateID string, version int, accessToken string) *http.Response {
	s.t.Helper()
	return s.get("/v1/templates/"+templateID+"/versions/"+strconv.Itoa(version)+"/file", accessToken)
}

// TestDownloadTemplateVersion covers the endpoint a client needs in order to
// work with a template's content rather than only its metadata.
func TestDownloadTemplateVersion(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("templatefile@example.com")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Lease agreement",
		buildDOCX(t, "Client {{", ".customer", "_name}}")), http.StatusCreated, &created)

	resp := server.downloadTemplateVersion(created.ID, 1, session.AccessToken)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want 200; body: %s", resp.StatusCode, body)
	}
	if contentType := resp.Header.Get("Content-Type"); !strings.Contains(contentType, "wordprocessingml") {
		t.Errorf("Content-Type = %q", contentType)
	}
	if disposition := resp.Header.Get("Content-Disposition"); !strings.Contains(disposition, "Lease agreement-v1.docx") {
		t.Errorf("Content-Disposition = %q, want it to name the template and version", disposition)
	}

	downloaded, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	// What comes back is the normalised archive, so the placeholder that was
	// split across runs on upload is now whole.
	document, ok := archivePart(t, downloaded, "word/document.xml")
	if !ok {
		t.Fatal("the downloaded archive has no word/document.xml")
	}
	if !strings.Contains(document, "{{.customer_name}}") {
		t.Errorf("the stored template is not the normalised one:\n%s", document)
	}
}

// TestDownloadTemplateVersionPreservesExtraParts is the property an authoring
// client depends on: a part it embeds in its own archive survives the upload
// and comes back intact, which is what makes a template reopenable for editing.
func TestDownloadTemplateVersionPreservesExtraParts(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("extraparts@example.com")

	const source = `{"blocks":[{"type":"paragraph","text":"Client {{.customer_name}}"}]}`
	archive := withExtraPart(t,
		buildDOCX(t, "Client {{.customer_name}}"),
		"imobiliary/source.json", source,
	)

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Authored", archive),
		http.StatusCreated, &created)

	resp := server.downloadTemplateVersion(created.ID, 1, session.AccessToken)
	defer resp.Body.Close()

	downloaded, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	got, ok := archivePart(t, downloaded, "imobiliary/source.json")
	if !ok {
		t.Fatal("the embedded source did not survive the round trip")
	}
	if got != source {
		t.Errorf("the embedded source came back changed:\ngot:  %s\nwant: %s", got, source)
	}
}

// TestDownloadTemplateVersionKeepsOlderVersionsReachable is what makes an
// existing document reproducible after its template has moved on.
func TestDownloadTemplateVersionKeepsOlderVersionsReachable(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("oldversions@example.com")

	var first templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Evolving",
		buildDOCX(t, "Version one {{.alpha}}")), http.StatusCreated, &first)

	expectStatus(t, server.uploadTemplate("/v1/templates/"+first.ID+"/versions", session.AccessToken, "",
		buildDOCX(t, "Version two {{.beta}}")), http.StatusCreated)

	for _, tc := range []struct {
		version int
		want    string
	}{
		{1, "{{.alpha}}"},
		{2, "{{.beta}}"},
	} {
		resp := server.downloadTemplateVersion(first.ID, tc.version, session.AccessToken)
		downloaded, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatalf("read version %d: %v", tc.version, err)
		}

		document, ok := archivePart(t, downloaded, "word/document.xml")
		if !ok {
			t.Fatalf("version %d has no document part", tc.version)
		}
		if !strings.Contains(document, tc.want) {
			t.Errorf("version %d does not contain %q", tc.version, tc.want)
		}
	}
}

func TestDownloadTemplateVersionRejectsBadRequests(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	owner := server.registerAndLogin("fileowner@example.com")
	stranger := server.registerAndLogin("filestranger@example.com")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", owner.AccessToken, "Private",
		buildDOCX(t, "Secret {{.value}}")), http.StatusCreated, &created)

	t.Run("another account cannot read it", func(t *testing.T) {
		expectStatus(t, server.downloadTemplateVersion(created.ID, 1, stranger.AccessToken), http.StatusNotFound)
	})

	t.Run("a version that does not exist", func(t *testing.T) {
		expectStatus(t, server.downloadTemplateVersion(created.ID, 99, owner.AccessToken), http.StatusNotFound)
	})

	t.Run("a version that is not a number", func(t *testing.T) {
		expectStatus(t, server.get("/v1/templates/"+created.ID+"/versions/abc/file", owner.AccessToken), http.StatusBadRequest)
	})

	t.Run("without credentials", func(t *testing.T) {
		expectStatus(t, server.downloadTemplateVersion(created.ID, 1, ""), http.StatusUnauthorized)
	})
}

// TestExportCarriesEverythingHeld covers the access and portability rights:
// what comes back has to be the whole of it, including what a soft delete
// merely hid.
func TestExportCarriesEverythingHeld(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("export@example.com")

	var kept templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Mantido",
		buildDOCX(t, "Locatario {{.locatario_cpf}}")), http.StatusCreated, &kept)

	var hidden templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Escondido",
		buildDOCX(t, "Outro {{.valor}}")), http.StatusCreated, &hidden)

	expectStatus(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
		"template_id": kept.ID,
		"data":        map[string]string{"locatario_cpf": "123.456.789-00"},
	}), http.StatusCreated)

	// "Deleting" a template only hides it, so the export must still list it.
	expectStatus(t, server.delete("/v1/templates/"+hidden.ID, session.AccessToken), http.StatusNoContent)

	resp := server.get("/v1/me/export", session.AccessToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("export answered %d, want 200", resp.StatusCode)
	}
	if disposition := resp.Header.Get("Content-Disposition"); !strings.Contains(disposition, "attachment") {
		t.Errorf("Content-Disposition = %q, want an attachment", disposition)
	}
	if cache := resp.Header.Get("Cache-Control"); cache != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cache)
	}

	var export struct {
		Office struct {
			Name string `json:"name"`
		} `json:"office"`
		Templates []struct {
			Name    string `json:"name"`
			Deleted bool   `json:"deleted"`
		} `json:"templates"`
		Documents []struct {
			Data map[string]string `json:"data"`
		} `json:"documents"`
	}
	decode(t, resp, http.StatusOK, &export)

	if export.Office.Name != "Escritório de export@example.com" {
		t.Errorf("export names office %q", export.Office.Name)
	}

	// The value the user typed is the substance of the export.
	if len(export.Documents) != 1 || export.Documents[0].Data["locatario_cpf"] != "123.456.789-00" {
		t.Errorf("export documents = %+v, want the filled value", export.Documents)
	}

	byName := map[string]bool{}
	for _, tmpl := range export.Templates {
		byName[tmpl.Name] = tmpl.Deleted
	}
	if len(export.Templates) != 2 {
		t.Fatalf("export listed %d templates, want both", len(export.Templates))
	}
	if byName["Mantido"] {
		t.Error("a live template is reported as deleted")
	}
	if !byName["Escondido"] {
		t.Error("a soft-deleted template is missing or unmarked; the export must say what is still held")
	}
}

func TestDeleteDocumentRemovesTheValuesTyped(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("one-document@example.com")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Contrato",
		buildDOCX(t, "CPF {{.cpf}}")), http.StatusCreated, &created)

	var document documentBody
	decode(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
		"template_id": created.ID,
		"data":        map[string]string{"cpf": "123.456.789-00"},
	}), http.StatusCreated, &document)

	before := server.storedBlobs()

	expectStatus(t, server.delete("/v1/documents/"+document.ID, session.AccessToken), http.StatusNoContent)

	expectStatus(t, server.get("/v1/documents/"+document.ID, session.AccessToken), http.StatusNotFound)
	expectStatus(t, server.get(document.DownloadURL, session.AccessToken), http.StatusNotFound)
	if got := server.storedBlobs(); got != before-1 {
		t.Errorf("stored %d files after deleting one document, want %d", got, before-1)
	}

	// Deleting twice is not a way to discover that something was there.
	expectStatus(t, server.delete("/v1/documents/"+document.ID, session.AccessToken), http.StatusNotFound)

	// The template is untouched — one document went, not the model behind it.
	expectStatus(t, server.get("/v1/templates/"+created.ID, session.AccessToken), http.StatusOK)
}

// Accounts, sessions and passwords moved to the platform: the old routes say so.
func TestAccountRoutesAreGone(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("gone@example.com")
	for _, path := range []string{"/v1/auth/register", "/v1/auth/login", "/v1/auth/refresh", "/v1/auth/password/forgot"} {
		expectStatus(t, server.postJSON(path, "", map[string]string{}), http.StatusGone)
	}
	expectStatus(t, server.postJSON("/v1/me/password", session.AccessToken, map[string]string{}), http.StatusGone)
	expectStatus(t, server.delete("/v1/me", session.AccessToken), http.StatusGone)
}

// A token from the platform is who the request speaks for; members of one
// office share its templates, and the office's name follows the platform.
func TestMembersOfAnOfficeShareItsTemplates(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	office := uuid.NewV7()
	ana := server.tokenFor(office, "ana@example.com", "Central")
	bia := server.tokenFor(office, "bia@example.com", "Central Imóveis")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", ana, "Contrato", buildDOCX(t, "Olá {{.nome}}")), http.StatusCreated, &created)
	expectStatus(t, server.get("/v1/templates/"+created.ID, bia), http.StatusOK)

	var me struct {
		User struct {
			Email string `json:"email"`
		} `json:"user"`
		Office struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"office"`
		Role string `json:"role"`
	}
	decode(t, server.get("/v1/me", bia), http.StatusOK, &me)
	if me.User.Email != "bia@example.com" || me.Office.ID != office.String() || me.Office.Name != "Central Imóveis" || me.Role != "member" {
		t.Errorf("me %+v", me)
	}
}

// An account from before the platform owned identity moves to the office of
// the first member who signs in with its e-mail, once.
func TestLegacyAccountMovesToTheOfficeByEmail(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	legacy := uuid.NewV7()
	legacyToken := server.tokenFor(legacy, "legacy-setup@example.com", "Setup")

	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", legacyToken, "Antigo", buildDOCX(t, "Olá {{.nome}}")), http.StatusCreated, &created)
	// Turn the setup office into what migration 0005 makes of an old account.
	raw, err := sql.Open("sqlite", server.dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	if _, err := raw.ExecContext(t.Context(),
		`UPDATE owners SET kind = 'legacy_account', email = 'ada@example.com' WHERE id = ?`, legacy[:]); err != nil {
		t.Fatal(err)
	}

	office := uuid.NewV7()
	ada := server.tokenFor(office, "ADA@example.com", "Central")
	expectStatus(t, server.get("/v1/templates/"+created.ID, ada), http.StatusOK)

	other := server.tokenFor(uuid.NewV7(), "ada@example.com", "Outro")
	expectStatus(t, server.get("/v1/templates/"+created.ID, other), http.StatusNotFound)
}

func TestDocumentsFilterByReference(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("ref@example.com")
	var created templateBody
	decode(t, server.uploadTemplate("/v1/templates", session.AccessToken, "Contrato", buildDOCX(t, "Olá {{.nome}}")), http.StatusCreated, &created)
	for _, ref := range []string{"contract:1", "contract:1", "contract:2", ""} {
		expectStatus(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
			"template_id": created.ID, "data": map[string]string{"nome": "Ana"}, "reference": ref,
		}), http.StatusCreated)
	}
	var list struct {
		Items []struct {
			Reference string `json:"reference"`
		} `json:"items"`
	}
	decode(t, server.get("/v1/documents?reference=contract:1", session.AccessToken), http.StatusOK, &list)
	if len(list.Items) != 2 || list.Items[0].Reference != "contract:1" {
		t.Errorf("documents for contract:1 = %+v", list.Items)
	}
	expectStatus(t, server.postJSON("/v1/documents", session.AccessToken, map[string]any{
		"template_id": created.ID, "data": map[string]string{"nome": "Ana"}, "reference": strings.Repeat("x", 101),
	}), http.StatusUnprocessableEntity)
}
