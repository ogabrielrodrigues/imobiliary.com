package docx

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

// wordprocessingNS is the WordprocessingML namespace. Elements are matched by
// namespace rather than by prefix because the prefix bound to it is a property
// of the document, not a constant.
const wordprocessingNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

// actionOpen and actionClose delimit a template action.
const (
	actionOpen  = "{{"
	actionClose = "}}"
)

// textSegment is the character data of one <w:t> element, together with the
// byte ranges it and its start tag occupy in the source XML.
type textSegment struct {
	tagStart int // first byte of the <w:t …> start tag
	start    int // first byte of the character data
	end      int // one past its last byte
	text     string
}

// edit replaces a byte range of the source.
//
// When tag is non-empty it is written before the text, and start points at the
// original start tag rather than at the character data — that is how a run
// gains xml:space="preserve" along with its new contents.
type edit struct {
	start int
	end   int
	text  string
	tag   string
}

// coalesceRuns rewrites a WordprocessingML part so that every template action
// lies inside a single <w:t> element.
//
// Word splits a paragraph into runs for reasons of its own — spell checking,
// revision history, a stray formatting toggle — so an author who types
// "{{customer_name}}" routinely ends up with that text scattered over three or
// four runs. Text/template would never match it. This pass moves each action
// into the run holding its first character and removes it from the others,
// which is also why the action inherits the formatting of that first character.
//
// The transformation is applied by splicing byte ranges of the original
// document rather than by re-serialising a parsed tree. Go's XML encoder
// rewrites namespace declarations in ways Word rejects; splicing leaves every
// byte outside the edited character data exactly as it was.
func coalesceRuns(src []byte) ([]byte, error) {
	dec := xml.NewDecoder(bytes.NewReader(src))

	// paragraphs is a stack, because a text box nests a whole paragraph inside
	// a run of its containing paragraph.
	var (
		paragraphs [][]textSegment
		edits      []edit
		current    textSegment
		content    strings.Builder
		inText     bool
	)

	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("docx: parse part: %w", err)
		}

		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Space != wordprocessingNS {
				continue
			}
			switch t.Name.Local {
			case "p":
				paragraphs = append(paragraphs, nil)
			case "t":
				if len(paragraphs) > 0 {
					inText = true
					content.Reset()
					offset := int(dec.InputOffset())
					current = textSegment{
						tagStart: startTagAt(src, offset),
						start:    offset,
						end:      offset,
					}
				}
			}

		case xml.CharData:
			if inText {
				content.Write(t)
				current.end = int(dec.InputOffset())
			}

		case xml.EndElement:
			if t.Name.Space != wordprocessingNS {
				continue
			}
			switch t.Name.Local {
			case "t":
				if inText {
					inText = false
					current.text = content.String()
					top := len(paragraphs) - 1
					paragraphs[top] = append(paragraphs[top], current)
				}
			case "p":
				if len(paragraphs) > 0 {
					top := len(paragraphs) - 1
					edits = append(edits, redistribute(src, paragraphs[top])...)
					paragraphs = paragraphs[:top]
				}
			}
		}
	}

	return applyEdits(src, edits)
}

// redistribute returns the edits that pull every template action of one
// paragraph into a single text segment.
func redistribute(src []byte, segments []textSegment) []edit {
	// A lone segment cannot have an action split across it.
	if len(segments) < 2 {
		return nil
	}

	// bounds[i] is where segment i begins within the concatenated paragraph
	// text, and bounds[len] is the total length.
	var joined strings.Builder
	bounds := make([]int, len(segments)+1)
	for i, s := range segments {
		bounds[i] = joined.Len()
		joined.WriteString(s.text)
	}
	bounds[len(segments)] = joined.Len()
	text := joined.String()

	actions := findActions(text)
	if len(actions) == 0 {
		return nil
	}

	// segmentAt reports which segment owns a byte of the paragraph text. Empty
	// segments are skipped naturally: their range is zero-width.
	segmentAt := func(pos int) int {
		return sort.Search(len(segments), func(i int) bool { return bounds[i+1] > pos })
	}

	// Redistribute every byte of the paragraph: ordinary text stays where it
	// was, while an action is emitted whole into the segment holding its first
	// byte. Treating single-segment actions the same way is harmless, since for
	// them the destination is the segment they already occupy.
	outputs := make([]strings.Builder, len(segments))
	pos := 0
	for _, a := range actions {
		for ; pos < a.start; pos++ {
			outputs[segmentAt(pos)].WriteByte(text[pos])
		}
		outputs[segmentAt(a.start)].WriteString(text[a.start:a.end])
		pos = a.end
	}
	for ; pos < len(text); pos++ {
		outputs[segmentAt(pos)].WriteByte(text[pos])
	}

	var edits []edit
	for i, s := range segments {
		got := outputs[i].String()
		if got == s.text {
			continue
		}

		// Moving text between runs can leave one starting or ending with a
		// space it did not have before. Word discards such a space unless the
		// element says to keep it, which is how "{{.day}} de setembro" comes
		// out of Word as "09de setembro". The tag is rewritten to say so.
		if needsSpacePreserved(got) {
			tag := string(src[s.tagStart:s.start])
			if !hasSpacePreserved(tag) {
				edits = append(edits, edit{
					start: s.tagStart,
					end:   s.end,
					text:  got,
					tag:   withSpacePreserved(tag),
				})
				continue
			}
		}

		edits = append(edits, edit{start: s.start, end: s.end, text: got})
	}
	return edits
}

// startTagAt finds the "<" that opens the element whose content begins at
// contentStart.
//
// XML forbids a raw "<" inside an attribute value, so the nearest one looking
// backwards is always the start of this tag.
func startTagAt(src []byte, contentStart int) int {
	for at := contentStart - 1; at >= 0; at-- {
		if src[at] == '<' {
			return at
		}
	}
	return contentStart
}

// needsSpacePreserved reports whether text would lose whitespace in a <w:t>
// that does not ask for it to be kept.
func needsSpacePreserved(text string) bool {
	return text != strings.TrimSpace(text)
}

func hasSpacePreserved(tag string) bool {
	return strings.Contains(tag, `xml:space="preserve"`) ||
		strings.Contains(tag, `xml:space='preserve'`)
}

// withSpacePreserved returns the tag with xml:space="preserve" added.
func withSpacePreserved(tag string) string {
	if !strings.HasSuffix(tag, ">") {
		return tag
	}
	// Self-closing tags hold no character data, so they never reach this.
	return strings.TrimSuffix(tag, ">") + ` xml:space="preserve">`
}

// span is a half-open byte range.
type span struct {
	start int
	end   int
}

// findActions locates the template actions in a paragraph's text. An unclosed
// action is left alone: the template parser reports it later with a far better
// message than this function could.
func findActions(s string) []span {
	var out []span
	for i := 0; i < len(s); {
		open := strings.Index(s[i:], actionOpen)
		if open < 0 {
			break
		}
		open += i

		shut := strings.Index(s[open+len(actionOpen):], actionClose)
		if shut < 0 {
			break
		}
		end := open + len(actionOpen) + shut + len(actionClose)

		out = append(out, span{start: open, end: end})
		i = end
	}
	return out
}

// applyEdits splices the replacements into the source, escaping each one as XML
// character data.
func applyEdits(src []byte, edits []edit) ([]byte, error) {
	if len(edits) == 0 {
		return src, nil
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].start < edits[j].start })

	var buf bytes.Buffer
	buf.Grow(len(src))

	prev := 0
	for _, e := range edits {
		if e.start < prev {
			return nil, errors.New("docx: overlapping edits")
		}
		buf.Write(src[prev:e.start])
		if e.tag != "" {
			buf.WriteString(e.tag)
		}
		if err := xml.EscapeText(&buf, []byte(e.text)); err != nil {
			return nil, fmt.Errorf("docx: escape text: %w", err)
		}
		prev = e.end
	}
	buf.Write(src[prev:])
	return buf.Bytes(), nil
}
