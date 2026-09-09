// Package docx renders DOCX documents by substituting values into an uploaded
// template.
//
// A .docx file is a ZIP archive whose text lives in WordprocessingML parts.
// This package treats those parts as text/template sources, which means the
// whole engine is built out of archive/zip, encoding/xml and text/template —
// no third-party OOXML library is involved.
package docx

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/template"
	"text/template/parse"

	"docgen/internal/domain"
)

// Limits on what an uploaded archive may contain. They bound the work a single
// upload can cause: without them a small archive could expand to gigabytes,
// the classic zip bomb.
const (
	MaxEntries          = 512
	MaxUncompressedSize = 100 << 20
	MaxPartSize         = 16 << 20
)

// mainDocumentPart is the part every Word document must contain.
const mainDocumentPart = "word/document.xml"

// Template is a compiled, ready-to-render DOCX template.
//
// It keeps the archive it was built from so that rendering copies the untouched
// parts straight across, and holds one parsed template per WordprocessingML
// part. Instances are immutable once compiled and therefore safe to share
// between concurrent requests.
type Template struct {
	archive      *zip.Reader
	parts        map[string]*template.Template
	placeholders []string
}

// Normalize prepares an uploaded DOCX for templating by pulling every template
// action into a single run. The returned archive is byte-identical to the input
// apart from the character data that had to move.
func Normalize(src []byte) ([]byte, error) {
	zr, err := openArchive(src)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	buf.Grow(len(src))
	zw := zip.NewWriter(&buf)

	for _, f := range zr.File {
		if !isTemplatedPart(f.Name) {
			// Copy transfers the entry's already-compressed bytes verbatim,
			// so untouched parts are never decompressed and recompressed.
			if err := zw.Copy(f); err != nil {
				return nil, fmt.Errorf("docx: copy part %q: %w", f.Name, err)
			}
			continue
		}

		part, err := readPart(f)
		if err != nil {
			return nil, err
		}
		normalized, err := coalesceRuns(part)
		if err != nil {
			return nil, fmt.Errorf("docx: normalize part %q: %w", f.Name, err)
		}

		w, err := zw.CreateHeader(&zip.FileHeader{
			Name:     f.Name,
			Method:   zip.Deflate,
			Modified: f.Modified,
		})
		if err != nil {
			return nil, fmt.Errorf("docx: create part %q: %w", f.Name, err)
		}
		if _, err := w.Write(normalized); err != nil {
			return nil, fmt.Errorf("docx: write part %q: %w", f.Name, err)
		}
	}

	if err := zw.Close(); err != nil {
		return nil, fmt.Errorf("docx: finalize archive: %w", err)
	}
	return buf.Bytes(), nil
}

// Compile parses a normalized DOCX and extracts its placeholder schema.
//
// Any problem with the template itself is reported as a domain validation
// error, since it is caused by the uploaded file rather than by the service.
func Compile(src []byte) (*Template, error) {
	zr, err := openArchive(src)
	if err != nil {
		return nil, err
	}

	t := &Template{
		archive: zr,
		parts:   make(map[string]*template.Template),
	}

	invalid := &domain.ValidationError{}
	found := make(map[string]struct{})

	for _, f := range zr.File {
		if !isTemplatedPart(f.Name) {
			continue
		}
		part, err := readPart(f)
		if err != nil {
			return nil, err
		}

		parsed, err := template.New(f.Name).Option("missingkey=error").Parse(string(part))
		if err != nil {
			invalid.Addf("template", "%s contains an invalid placeholder: %s", f.Name, cleanParseError(err))
			continue
		}
		collectPlaceholders(parsed, f.Name, found, invalid)
		t.parts[f.Name] = parsed
	}

	if len(found) > domain.MaxPlaceholders {
		invalid.Addf("template", "declares %d placeholders, the maximum is %d", len(found), domain.MaxPlaceholders)
	}
	if err := invalid.OrNil(); err != nil {
		return nil, err
	}

	t.placeholders = make([]string, 0, len(found))
	for name := range found {
		t.placeholders = append(t.placeholders, name)
	}
	sort.Strings(t.placeholders)
	return t, nil
}

// Placeholders returns the field names the template expects, sorted.
func (t *Template) Placeholders() []string {
	return t.placeholders
}

// Render writes a filled-in DOCX to w.
//
// Values are XML-escaped before substitution. Skipping that step is how a naive
// implementation corrupts its own output: a value containing "&" or "<" would
// produce malformed XML and a file Word refuses to open.
func (t *Template) Render(w io.Writer, data map[string]string) error {
	escaped := make(map[string]string, len(data))
	for name, value := range data {
		var buf bytes.Buffer
		if err := xml.EscapeText(&buf, []byte(value)); err != nil {
			return fmt.Errorf("docx: escape value %q: %w", name, err)
		}
		escaped[name] = buf.String()
	}

	zw := zip.NewWriter(w)
	for _, f := range t.archive.File {
		parsed, templated := t.parts[f.Name]
		if !templated {
			if err := zw.Copy(f); err != nil {
				return fmt.Errorf("docx: copy part %q: %w", f.Name, err)
			}
			continue
		}

		out, err := zw.CreateHeader(&zip.FileHeader{
			Name:     f.Name,
			Method:   zip.Deflate,
			Modified: f.Modified,
		})
		if err != nil {
			return fmt.Errorf("docx: create part %q: %w", f.Name, err)
		}
		if err := parsed.Execute(out, escaped); err != nil {
			return fmt.Errorf("docx: render part %q: %w", f.Name, err)
		}
	}
	return zw.Close()
}

// openArchive validates an uploaded archive and returns a reader over it.
func openArchive(src []byte) (*zip.Reader, error) {
	zr, err := zip.NewReader(bytes.NewReader(src), int64(len(src)))
	if err != nil {
		return nil, validation("file is not a valid .docx archive")
	}
	if len(zr.File) > MaxEntries {
		return nil, validation(fmt.Sprintf("archive holds more than %d entries", MaxEntries))
	}

	var total uint64
	var hasDocument bool
	for _, f := range zr.File {
		if !isSafeEntryName(f.Name) {
			return nil, validation(fmt.Sprintf("archive holds an unsafe entry name %q", f.Name))
		}
		// The declared size is only a hint from the archive itself, but a
		// dishonest one is caught later by the per-part read limit.
		total += f.UncompressedSize64
		if total > MaxUncompressedSize {
			return nil, validation("archive expands beyond the allowed size")
		}
		if f.Name == mainDocumentPart {
			hasDocument = true
		}
	}
	if !hasDocument {
		return nil, validation("archive is missing " + mainDocumentPart)
	}
	return zr, nil
}

// isSafeEntryName rejects archive entries whose names could escape a directory.
// Nothing here is ever written to disk under its archive name, so this is
// defence in depth rather than the only barrier.
func isSafeEntryName(name string) bool {
	if name == "" || strings.HasPrefix(name, "/") {
		return false
	}
	if strings.ContainsRune(name, '\\') {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return false
		}
	}
	return true
}

// readPart decompresses one entry under a hard size cap, so a lying header
// cannot make the service allocate without bound.
func readPart(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("docx: open part %q: %w", f.Name, err)
	}
	defer rc.Close()

	// One extra byte distinguishes "exactly at the limit" from "over it".
	data, err := io.ReadAll(io.LimitReader(rc, MaxPartSize+1))
	if err != nil {
		return nil, fmt.Errorf("docx: read part %q: %w", f.Name, err)
	}
	if len(data) > MaxPartSize {
		return nil, validation(fmt.Sprintf("part %q is larger than the allowed size", f.Name))
	}
	return data, nil
}

// isTemplatedPart reports whether a part carries user-visible text. Headers and
// footers are included so a placeholder works there too.
func isTemplatedPart(name string) bool {
	if name == mainDocumentPart {
		return true
	}
	if !strings.HasSuffix(name, ".xml") {
		return false
	}
	return strings.HasPrefix(name, "word/header") || strings.HasPrefix(name, "word/footer")
}

func validation(message string) error {
	v := &domain.ValidationError{}
	v.Add("template", message)
	return v
}

// cleanParseError strips the internal part name from a parse error, which would
// otherwise leak the part path into the API response.
func cleanParseError(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, ": "); i >= 0 {
		msg = msg[i+2:]
	}
	return msg
}

// collectPlaceholders walks a parsed template and records the field names it
// references.
//
// Only a bare field action such as {{.customer_name}} is accepted. The template
// comes from an untrusted upload, so the grammar is kept as small as the
// feature needs: no pipelines, no function calls, no variables, no control
// flow. A narrow grammar is both easier to reason about and easier to explain
// back to the author when their file is rejected.
func collectPlaceholders(t *template.Template, part string, found map[string]struct{}, invalid *domain.ValidationError) {
	var walk func(parse.Node)
	walk = func(n parse.Node) {
		switch n := n.(type) {
		case *parse.ListNode:
			if n == nil {
				return
			}
			for _, child := range n.Nodes {
				walk(child)
			}
		case *parse.TextNode:
			return
		case *parse.ActionNode:
			name, err := simpleField(n.Pipe)
			if err != nil {
				invalid.Addf("template", "%s: %s", part, err)
				return
			}
			if !domain.IsValidPlaceholderName(name) {
				invalid.Addf("template", "%s: placeholder %q must be lowercase snake_case", part, name)
				return
			}
			found[name] = struct{}{}
		default:
			invalid.Addf("template", "%s: unsupported construct %s", part, strings.TrimSpace(n.String()))
		}
	}
	walk(t.Tree.Root)
}

// simpleField returns the single field name a pipeline refers to, rejecting
// anything more elaborate.
func simpleField(pipe *parse.PipeNode) (string, error) {
	switch {
	case pipe == nil:
		return "", errors.New("empty placeholder")
	case len(pipe.Decl) > 0:
		return "", errors.New("variable assignment is not allowed in a placeholder")
	case len(pipe.Cmds) != 1:
		return "", errors.New("pipelines are not allowed in a placeholder")
	}

	cmd := pipe.Cmds[0]
	if len(cmd.Args) != 1 {
		return "", errors.New("function calls are not allowed in a placeholder")
	}
	field, ok := cmd.Args[0].(*parse.FieldNode)
	if !ok {
		return "", fmt.Errorf("%s is not a placeholder; use the form {{.field_name}}", strings.TrimSpace(cmd.Args[0].String()))
	}
	if len(field.Ident) != 1 {
		return "", errors.New("nested fields are not supported in a placeholder")
	}
	return field.Ident[0], nil
}
