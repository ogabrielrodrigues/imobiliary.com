//go:build integration

package http_test

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
)

type batchBody struct {
	ID              string `json:"id"`
	TemplateID      string `json:"template_id"`
	TemplateVersion int    `json:"template_version"`
	Name            string `json:"name"`
	Documents       int    `json:"documents"`
	Size            int64  `json:"size"`
	DownloadURL     string `json:"download_url"`
}

type batchDocumentBody struct {
	ID              string  `json:"id"`
	TemplateID      string  `json:"template_id"`
	TemplateVersion int     `json:"template_version"`
	Filename        string  `json:"filename"`
	BatchID         *string `json:"batch_id"`
}

type historyBody struct {
	Items []struct {
		Kind     string             `json:"kind"`
		Document *batchDocumentBody `json:"document"`
		Batch    *batchBody         `json:"batch"`
	} `json:"items"`
}

type documentListBody struct {
	Items []batchDocumentBody `json:"items"`
}

// uploadNamed uploads a template whose single placeholder is {{.name}}.
func (s *testServer) uploadNamed(accessToken, templateName string) templateBody {
	s.t.Helper()
	var template templateBody
	decode(s.t, s.uploadTemplate("/v1/templates", accessToken, templateName,
		buildDOCX(s.t, "Documento de {{.name}}")), http.StatusCreated, &template)
	return template
}

func (s *testServer) createBatch(accessToken, templateID, name string) batchBody {
	s.t.Helper()
	var batch batchBody
	decode(s.t, s.postJSON("/v1/batches", accessToken, map[string]any{
		"template_id": templateID,
		"name":        name,
	}), http.StatusCreated, &batch)
	return batch
}

// generateNamed renders one document with the given value, filename and batch
// ("" for none).
func (s *testServer) generateNamed(accessToken, templateID, batchID, filename, value string) batchDocumentBody {
	s.t.Helper()
	body := map[string]any{
		"template_id": templateID,
		"filename":    filename,
		"data":        map[string]string{"name": value},
	}
	if batchID != "" {
		body["batch_id"] = batchID
	}
	var document batchDocumentBody
	decode(s.t, s.postJSON("/v1/documents", accessToken, body), http.StatusCreated, &document)
	return document
}

func expectFieldError(t *testing.T, resp *http.Response, field string) {
	t.Helper()
	var failure errorBody
	decode(t, resp, http.StatusUnprocessableEntity, &failure)
	for _, f := range failure.Error.Fields {
		if f.Field == field {
			return
		}
	}
	t.Errorf("validation fields = %+v, want one on %q", failure.Error.Fields, field)
}

func TestHistoryMixesBatchesAndSingleDocuments(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("history@example.com")
	template := server.uploadNamed(session.AccessToken, "Aditamento")

	early := server.generateNamed(session.AccessToken, template.ID, "", "avulso-antes", "Bia")
	batch := server.createBatch(session.AccessToken, template.ID, "Aditamentos de setembro")
	inBatch := server.generateNamed(session.AccessToken, template.ID, batch.ID, "Aditamento - Ana", "Ana")
	server.generateNamed(session.AccessToken, template.ID, batch.ID, "Aditamento - Caio", "Caio")
	late := server.generateNamed(session.AccessToken, template.ID, "", "avulso-depois", "Duda")

	if inBatch.BatchID == nil || *inBatch.BatchID != batch.ID || inBatch.TemplateVersion != 1 {
		t.Errorf("document in batch = %+v, want batch %s at version 1", inBatch, batch.ID)
	}
	if late.BatchID != nil {
		t.Errorf("a document generated on its own reports batch %v", *late.BatchID)
	}

	var history historyBody
	decode(t, server.get("/v1/history", session.AccessToken), http.StatusOK, &history)

	// Newest first, and the batch's documents do not appear loose.
	if len(history.Items) != 3 {
		t.Fatalf("history has %d entries, want 3: %+v", len(history.Items), history.Items)
	}
	kinds := []string{history.Items[0].Kind, history.Items[1].Kind, history.Items[2].Kind}
	if !slices.Equal(kinds, []string{"document", "batch", "document"}) {
		t.Fatalf("history kinds = %v, want document, batch, document", kinds)
	}
	if history.Items[0].Document.ID != late.ID || history.Items[2].Document.ID != early.ID {
		t.Errorf("single documents out of order: %+v", history.Items)
	}
	got := history.Items[1].Batch
	if got.ID != batch.ID || got.Name != "Aditamentos de setembro" || got.Documents != 2 || got.Size <= 0 {
		t.Errorf("batch entry = %+v, want %s with 2 documents", got, batch.ID)
	}
	if got.DownloadURL != "/v1/batches/"+batch.ID+"/download" {
		t.Errorf("download_url = %q", got.DownloadURL)
	}

	// Paging walks the same mixed order.
	decode(t, server.get("/v1/history?limit=1&offset=1", session.AccessToken), http.StatusOK, &history)
	if len(history.Items) != 1 || history.Items[0].Kind != "batch" {
		t.Errorf("second page = %+v, want the batch", history.Items)
	}
}

func TestDocumentsAndHistoryFilterByTemplateAndBatch(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("filters@example.com")
	lease := server.uploadNamed(session.AccessToken, "Locação")
	receipt := server.uploadNamed(session.AccessToken, "Recibo")

	batch := server.createBatch(session.AccessToken, lease.ID, "Locações")
	server.generateNamed(session.AccessToken, lease.ID, batch.ID, "a", "Ana")
	server.generateNamed(session.AccessToken, lease.ID, "", "b", "Bia")
	server.generateNamed(session.AccessToken, receipt.ID, "", "c", "Caio")

	var documents documentListBody
	decode(t, server.get("/v1/documents?template_id="+lease.ID, session.AccessToken), http.StatusOK, &documents)
	if len(documents.Items) != 2 {
		t.Errorf("documents of Locação = %d, want 2 (one in a batch, one loose)", len(documents.Items))
	}
	decode(t, server.get("/v1/documents?batch_id="+batch.ID, session.AccessToken), http.StatusOK, &documents)
	if len(documents.Items) != 1 || documents.Items[0].Filename != "a.docx" {
		t.Errorf("documents of the batch = %+v, want a.docx", documents.Items)
	}

	var history historyBody
	decode(t, server.get("/v1/history?template_id="+receipt.ID, session.AccessToken), http.StatusOK, &history)
	if len(history.Items) != 1 || history.Items[0].Document == nil || history.Items[0].Document.Filename != "c.docx" {
		t.Errorf("history of Recibo = %+v, want c.docx alone", history.Items)
	}
	decode(t, server.get("/v1/history?template_id="+lease.ID, session.AccessToken), http.StatusOK, &history)
	if len(history.Items) != 2 {
		t.Errorf("history of Locação has %d entries, want the loose document and the batch", len(history.Items))
	}

	expectFieldError(t, server.get("/v1/history?template_id=nope", session.AccessToken), "template_id")
	expectFieldError(t, server.get("/v1/documents?batch_id=nope", session.AccessToken), "batch_id")
}

func TestBatchArchiveHoldsEveryDocument(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("archive@example.com")
	template := server.uploadNamed(session.AccessToken, "Aditamento")
	batch := server.createBatch(session.AccessToken, template.ID, "Lote 12/09")

	server.generateNamed(session.AccessToken, template.ID, batch.ID, "Aditamento - Ana", "Ana")
	server.generateNamed(session.AccessToken, template.ID, batch.ID, "Aditamento - Ana", "Ana Paula")
	server.generateNamed(session.AccessToken, template.ID, batch.ID, "Aditamento - Caio", "Caio")

	resp := server.get("/v1/batches/"+batch.ID+"/download", session.AccessToken)
	defer resp.Body.Close()
	// Checked by hand: expectStatus closes the body, and the archive is in it.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	if got := resp.Header.Get("Content-Type"); got != "application/zip" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := resp.Header.Get("Content-Disposition"); got != `attachment; filename="Lote 12_09.zip"` {
		t.Errorf("Content-Disposition = %q", got)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read archive: %v", err)
	}
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("the download is not a ZIP: %v", err)
	}

	var names []string
	for _, entry := range archive.File {
		names = append(names, entry.Name)
		body, err := entry.Open()
		if err != nil {
			t.Fatalf("open %s: %v", entry.Name, err)
		}
		content, err := io.ReadAll(body)
		body.Close()
		if err != nil {
			t.Fatalf("read %s: %v", entry.Name, err)
		}
		if !bytes.HasPrefix(content, []byte("PK")) {
			t.Errorf("%s is not a .docx archive", entry.Name)
		}
	}
	// In the order generated, and the repeated name made unique.
	want := []string{"Aditamento - Ana.docx", "Aditamento - Ana (2).docx", "Aditamento - Caio.docx"}
	if !slices.Equal(names, want) {
		t.Errorf("entries = %q, want %q", names, want)
	}
	if text := documentText(t, readEntry(t, archive, "Aditamento - Ana (2).docx")); !strings.Contains(text, "Ana Paula") {
		t.Errorf("second entry holds %q, want the Ana Paula document", text)
	}
}

func readEntry(t *testing.T, archive *zip.Reader, name string) []byte {
	t.Helper()
	for _, entry := range archive.File {
		if entry.Name != name {
			continue
		}
		body, err := entry.Open()
		if err != nil {
			t.Fatalf("open %s: %v", name, err)
		}
		defer body.Close()
		content, err := io.ReadAll(body)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return content
	}
	t.Fatalf("no entry %s", name)
	return nil
}

func TestDeleteBatchRemovesItsDocumentsAndFiles(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("delete-batch@example.com")
	template := server.uploadNamed(session.AccessToken, "Aditamento")

	loose := server.generateNamed(session.AccessToken, template.ID, "", "avulso", "Bia")
	before := server.storedBlobs()

	batch := server.createBatch(session.AccessToken, template.ID, "Para apagar")
	first := server.generateNamed(session.AccessToken, template.ID, batch.ID, "a", "Ana")
	server.generateNamed(session.AccessToken, template.ID, batch.ID, "b", "Caio")
	if server.storedBlobs() != before+2 {
		t.Fatalf("stored blobs = %d, want %d after two distinct documents", server.storedBlobs(), before+2)
	}

	expectStatus(t, server.delete("/v1/batches/"+batch.ID, session.AccessToken), http.StatusNoContent)

	expectStatus(t, server.get("/v1/batches/"+batch.ID, session.AccessToken), http.StatusNotFound)
	expectStatus(t, server.get("/v1/documents/"+first.ID, session.AccessToken), http.StatusNotFound)
	if got := server.storedBlobs(); got != before {
		t.Errorf("stored blobs = %d after deleting the batch, want %d", got, before)
	}

	var history historyBody
	decode(t, server.get("/v1/history", session.AccessToken), http.StatusOK, &history)
	if len(history.Items) != 1 || history.Items[0].Document == nil || history.Items[0].Document.ID != loose.ID {
		t.Errorf("history after deleting the batch = %+v, want the loose document alone", history.Items)
	}
	expectStatus(t, server.delete("/v1/batches/"+batch.ID, session.AccessToken), http.StatusNotFound)
}

func TestBatchRules(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	owner := server.registerAndLogin("batch-owner@example.com")
	stranger := server.registerAndLogin("batch-stranger@example.com")

	template := server.uploadNamed(owner.AccessToken, "Aditamento")
	other := server.uploadNamed(owner.AccessToken, "Recibo")
	batch := server.createBatch(owner.AccessToken, template.ID, "Setembro")

	// The batch keeps the version it was created for, even after a new one.
	var v2 templateBody
	decode(t, server.uploadTemplate("/v1/templates/"+template.ID+"/versions", owner.AccessToken, "",
		buildDOCX(t, "Nova versão para {{.name}}")), http.StatusCreated, &v2)
	joined := server.generateNamed(owner.AccessToken, template.ID, batch.ID, "a", "Ana")
	if joined.TemplateVersion != 1 {
		t.Errorf("document joined to a version-1 batch rendered version %d", joined.TemplateVersion)
	}

	t.Run("a document must use the batch's template and version", func(t *testing.T) {
		expectFieldError(t, server.postJSON("/v1/documents", owner.AccessToken, map[string]any{
			"template_id": other.ID, "batch_id": batch.ID, "data": map[string]string{"name": "x"},
		}), "batch_id")
		expectFieldError(t, server.postJSON("/v1/documents", owner.AccessToken, map[string]any{
			"template_id": template.ID, "batch_id": batch.ID, "version": 2, "data": map[string]string{"name": "x"},
		}), "batch_id")
		expectFieldError(t, server.postJSON("/v1/documents", owner.AccessToken, map[string]any{
			"template_id": template.ID, "batch_id": "not-an-id", "data": map[string]string{"name": "x"},
		}), "batch_id")
	})

	t.Run("another account's batch does not exist", func(t *testing.T) {
		strangerTemplate := server.uploadNamed(stranger.AccessToken, "Aditamento")
		expectFieldError(t, server.postJSON("/v1/documents", stranger.AccessToken, map[string]any{
			"template_id": strangerTemplate.ID, "batch_id": batch.ID, "data": map[string]string{"name": "x"},
		}), "batch_id")
		expectStatus(t, server.get("/v1/batches/"+batch.ID, stranger.AccessToken), http.StatusNotFound)
		expectStatus(t, server.get("/v1/batches/"+batch.ID+"/download", stranger.AccessToken), http.StatusNotFound)
		expectStatus(t, server.delete("/v1/batches/"+batch.ID, stranger.AccessToken), http.StatusNotFound)
		expectStatus(t, server.postJSON("/v1/batches", stranger.AccessToken, map[string]any{
			"template_id": template.ID, "name": "Alheio",
		}), http.StatusNotFound)

		var history historyBody
		decode(t, server.get("/v1/history", stranger.AccessToken), http.StatusOK, &history)
		if len(history.Items) != 0 {
			t.Errorf("a stranger's history shows %+v", history.Items)
		}
	})

	t.Run("a batch needs a name and a template", func(t *testing.T) {
		expectFieldError(t, server.postJSON("/v1/batches", owner.AccessToken, map[string]any{
			"template_id": template.ID, "name": "   ",
		}), "name")
		expectFieldError(t, server.postJSON("/v1/batches", owner.AccessToken, map[string]any{
			"template_id": template.ID, "name": strings.Repeat("a", 121),
		}), "name")
		expectFieldError(t, server.postJSON("/v1/batches", owner.AccessToken, map[string]any{
			"template_id": "nope", "name": "Setembro",
		}), "template_id")
	})

	t.Run("batches require authentication", func(t *testing.T) {
		expectStatus(t, server.get("/v1/history", ""), http.StatusUnauthorized)
		expectStatus(t, server.postJSON("/v1/batches", "", map[string]any{}), http.StatusUnauthorized)
	})
}

func TestExportIncludesBatches(t *testing.T) {
	server := newTestServer(t, defaultServerOptions())
	session := server.registerAndLogin("export-batches@example.com")
	template := server.uploadNamed(session.AccessToken, "Aditamento")
	batch := server.createBatch(session.AccessToken, template.ID, "Aditamentos da Ana")
	server.generateNamed(session.AccessToken, template.ID, batch.ID, "a", "Ana")

	var export struct {
		Batches []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"batches"`
		Documents []struct {
			BatchID *string `json:"batch_id"`
		} `json:"documents"`
	}
	decode(t, server.get("/v1/me/export", session.AccessToken), http.StatusOK, &export)

	if len(export.Batches) != 1 || export.Batches[0].ID != batch.ID || export.Batches[0].Name != "Aditamentos da Ana" {
		t.Errorf("export batches = %+v", export.Batches)
	}
	if len(export.Documents) != 1 || export.Documents[0].BatchID == nil || *export.Documents[0].BatchID != batch.ID {
		t.Errorf("export documents = %+v, want the batch recorded", export.Documents)
	}
}
