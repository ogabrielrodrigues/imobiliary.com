package docx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"slices"
	"strings"
	"testing"

	"docgen/internal/domain"
)

// contentTypes and rels are the minimum an archive needs for zip.Reader to see
// a well-formed package. Word itself demands more, but nothing in this package
// inspects them.
const (
	contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`

	packageRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
)

// documentWith wraps paragraph markup in a complete document part.
func documentWith(body string) string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>` + body + `</w:body>
</w:document>`
}

// runs builds a paragraph whose text is split across one run per argument. It
// reproduces the way Word fragments a paragraph it has edited.
func runs(texts ...string) string {
	var b strings.Builder
	b.WriteString("<w:p>")
	for _, text := range texts {
		b.WriteString(`<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">`)
		b.WriteString(text)
		b.WriteString(`</w:t></w:r>`)
	}
	b.WriteString("</w:p>")
	return b.String()
}

// buildDOCX assembles an archive from the given parts plus the boilerplate.
func buildDOCX(t *testing.T, parts map[string]string) []byte {
	t.Helper()

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	all := map[string]string{
		"[Content_Types].xml": contentTypes,
		"_rels/.rels":         packageRels,
	}
	for name, content := range parts {
		all[name] = content
	}

	names := make([]string, 0, len(all))
	for name := range all {
		names = append(names, name)
	}
	slices.Sort(names)

	for _, name := range names {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("create entry %q: %v", name, err)
		}
		if _, err := io.WriteString(w, all[name]); err != nil {
			t.Fatalf("write entry %q: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("close archive: %v", err)
	}
	return buf.Bytes()
}

// partOf returns one entry of an archive as a string.
func partOf(t *testing.T, archive []byte, name string) string {
	t.Helper()

	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open part %q: %v", name, err)
		}
		defer rc.Close()

		data, err := io.ReadAll(rc)
		if err != nil {
			t.Fatalf("read part %q: %v", name, err)
		}
		return string(data)
	}
	t.Fatalf("part %q not found in archive", name)
	return ""
}

// entryNames lists every entry of an archive.
func entryNames(t *testing.T, archive []byte) []string {
	t.Helper()

	zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("open archive: %v", err)
	}
	names := make([]string, 0, len(zr.File))
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	slices.Sort(names)
	return names
}

// render is the whole pipeline: normalize, compile, render.
func render(t *testing.T, source []byte, data map[string]string) []byte {
	t.Helper()

	normalized, err := Normalize(source)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	tpl, err := Compile(normalized)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	var out bytes.Buffer
	if err := tpl.Render(&out, data); err != nil {
		t.Fatalf("render: %v", err)
	}
	return out.Bytes()
}

// TestNormalizeJoinsActionSplitAcrossRuns covers the case that defeats a naive
// implementation: Word has scattered a single placeholder over several runs, so
// the literal "{{.customer_name}}" appears nowhere in the source XML.
func TestNormalizeJoinsActionSplitAcrossRuns(t *testing.T) {
	source := buildDOCX(t, map[string]string{
		"word/document.xml": documentWith(runs("Dear {{", ".customer", "_name}}, welcome.")),
	})

	normalized, err := Normalize(source)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}

	part := partOf(t, normalized, "word/document.xml")
	if !strings.Contains(part, "{{.customer_name}}") {
		t.Errorf("placeholder was not joined into a single run:\n%s", part)
	}

	// The text that surrounded the placeholder must survive untouched.
	for _, want := range []string{"Dear ", ", welcome."} {
		if !strings.Contains(part, want) {
			t.Errorf("surrounding text %q was lost:\n%s", want, part)
		}
	}

	tpl, err := Compile(normalized)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if got := tpl.Placeholders(); !slices.Equal(got, []string{"customer_name"}) {
		t.Errorf("Placeholders() = %v, want [customer_name]", got)
	}
}

// TestNormalizeIsIdempotent guards against a second pass corrupting a document
// that has already been normalized.
func TestNormalizeIsIdempotent(t *testing.T) {
	source := buildDOCX(t, map[string]string{
		"word/document.xml": documentWith(runs("Total: {{", ".amount", "}}")),
	})

	once, err := Normalize(source)
	if err != nil {
		t.Fatalf("first normalize: %v", err)
	}
	twice, err := Normalize(once)
	if err != nil {
		t.Fatalf("second normalize: %v", err)
	}

	if a, b := partOf(t, once, "word/document.xml"), partOf(t, twice, "word/document.xml"); a != b {
		t.Errorf("second pass changed the document:\nfirst:  %s\nsecond: %s", a, b)
	}
}

// TestRenderSubstitutesValues checks the happy path end to end.
func TestRenderSubstitutesValues(t *testing.T) {
	source := buildDOCX(t, map[string]string{
		"word/document.xml": documentWith(runs("Dear {{", ".customer", "_name}}, your plan is {{.plan}}.")),
	})

	out := render(t, source, map[string]string{
		"customer_name": "Ada Lovelace",
		"plan":          "Premium",
	})

	part := partOf(t, out, "word/document.xml")
	for _, want := range []string{"Ada Lovelace", "Premium"} {
		if !strings.Contains(part, want) {
			t.Errorf("rendered document is missing %q:\n%s", want, part)
		}
	}
	if strings.Contains(part, "{{") {
		t.Errorf("rendered document still contains an unsubstituted action:\n%s", part)
	}
}

// TestRenderEscapesXMLSpecialCharacters is the regression test for the mistake
// that silently produces files Word refuses to open: injecting a raw "&" or
// "<" into the document part.
func TestRenderEscapesXMLSpecialCharacters(t *testing.T) {
	source := buildDOCX(t, map[string]string{
		"word/document.xml": documentWith(runs("Client: {{.customer_name}}")),
	})

	out := render(t, source, map[string]string{
		"customer_name": `Smith & Sons <Holdings> "Ltd"`,
	})

	part := partOf(t, out, "word/document.xml")
	if strings.Contains(part, "& Sons") || strings.Contains(part, "<Holdings>") {
		t.Errorf("value was injected without escaping:\n%s", part)
	}
	if !strings.Contains(part, "&amp; Sons") {
		t.Errorf("ampersand was not escaped:\n%s", part)
	}

	// The real assertion: the result must still parse as XML.
	if err := parsesAsXML(part); err != nil {
		t.Errorf("rendered part is not well-formed XML: %v\n%s", err, part)
	}
}

// TestRenderCopiesUntouchedParts verifies that parts carrying no text are
// passed through, since losing them would corrupt the package.
func TestRenderCopiesUntouchedParts(t *testing.T) {
	source := buildDOCX(t, map[string]string{
		"word/document.xml": documentWith(runs("Hello {{.name}}")),
		"word/styles.xml":   `<styles>unchanged</styles>`,
	})

	out := render(t, source, map[string]string{"name": "Ada"})

	want := []string{"[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"}
	if got := entryNames(t, out); !slices.Equal(got, want) {
		t.Errorf("entries = %v, want %v", got, want)
	}
	if got := partOf(t, out, "word/styles.xml"); got != `<styles>unchanged</styles>` {
		t.Errorf("styles.xml was modified: %q", got)
	}
}

// TestCompileCollectsPlaceholdersFromHeadersAndFooters confirms the schema is
// the union across every text-bearing part.
func TestCompileCollectsPlaceholdersFromHeadersAndFooters(t *testing.T) {
	source := buildDOCX(t, map[string]string{
		"word/document.xml": documentWith(runs("Body {{.body_field}}")),
		"word/header1.xml":  documentWith(runs("Header {{.header_field}}")),
		"word/footer1.xml":  documentWith(runs("Footer {{.footer_field}}")),
	})

	normalized, err := Normalize(source)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	tpl, err := Compile(normalized)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	want := []string{"body_field", "footer_field", "header_field"}
	if got := tpl.Placeholders(); !slices.Equal(got, want) {
		t.Errorf("Placeholders() = %v, want %v", got, want)
	}
}

// TestCompileRejectsUnsupportedConstructs pins down the deliberately narrow
// grammar accepted from an untrusted upload.
func TestCompileRejectsUnsupportedConstructs(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"function call", `{{printf "%s" .name}}`},
		{"pipeline", `{{.name | printf}}`},
		{"conditional", `{{if .name}}yes{{end}}`},
		{"range", `{{range .items}}x{{end}}`},
		{"variable", `{{$x := .name}}`},
		{"nested field", `{{.customer.name}}`},
		{"uppercase name", `{{.CustomerName}}`},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			source := buildDOCX(t, map[string]string{
				"word/document.xml": documentWith(runs(tc.body)),
			})

			normalized, err := Normalize(source)
			if err != nil {
				t.Fatalf("normalize: %v", err)
			}
			if _, err := Compile(normalized); !errors.Is(err, domain.ErrValidation) {
				t.Errorf("Compile() error = %v, want a validation error", err)
			}
		})
	}
}

// TestRenderRejectsMissingValue relies on missingkey=error as the last line of
// defence, behind the explicit validation performed by the use case.
func TestRenderRejectsMissingValue(t *testing.T) {
	source := buildDOCX(t, map[string]string{
		"word/document.xml": documentWith(runs("Hello {{.name}}")),
	})

	normalized, err := Normalize(source)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	tpl, err := Compile(normalized)
	if err != nil {
		t.Fatalf("compile: %v", err)
	}

	if err := tpl.Render(io.Discard, map[string]string{}); err == nil {
		t.Error("Render() succeeded with no value for the placeholder, want an error")
	}
}

// TestOpenArchiveRejectsInvalidUploads covers the upload validation rules.
func TestOpenArchiveRejectsInvalidUploads(t *testing.T) {
	t.Run("not a zip archive", func(t *testing.T) {
		if _, err := Normalize([]byte("this is not a zip file")); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("Normalize() error = %v, want a validation error", err)
		}
	})

	t.Run("missing document part", func(t *testing.T) {
		source := buildDOCX(t, map[string]string{
			"word/notes.xml": `<notes/>`,
		})
		if _, err := Normalize(source); !errors.Is(err, domain.ErrValidation) {
			t.Errorf("Normalize() error = %v, want a validation error", err)
		}
	})
}

// parsesAsXML reports whether s is well-formed XML.
func parsesAsXML(s string) error {
	dec := xml.NewDecoder(strings.NewReader(s))
	for {
		_, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
