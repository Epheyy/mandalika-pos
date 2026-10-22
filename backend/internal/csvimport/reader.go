// Package csvimport is the pure (no database) half of the A39 CSV import: a standards
// reader on top of encoding/csv, value parsers, and the per-kind planners that turn a
// parsed file plus a snapshot of current data into one Report. The same code path
// serves the preview (dry run) and the commit, so the two cannot drift.
package csvimport

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

// File limits (D9).
const (
	MaxBytes = 16 << 20
	MaxRows  = 50000
	MaxCols  = 40
)

var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// ColumnSpec describes one expected column. Key is the canonical (display) name used in
// Row.Cells and messages; Aliases are extra accepted header spellings.
type ColumnSpec struct {
	Key      string
	Aliases  []string
	Required bool
}

// Spec lists the columns of one import kind. Ignored names are known export columns
// (e.g. "Poin") that are skipped with a warning.
type Spec struct {
	Columns []ColumnSpec
	Ignored []string
}

// Row is one data record. Index is the 1-based data-row index, Line the physical line
// the record starts on. Cells holds every spec column (blank = ""), after the apostrophe
// guard reversal. Problems are structural row errors found by the reader itself.
type Row struct {
	Index    int
	Line     int
	Cells    map[string]string
	Problems []Issue
}

// Table is a parsed file.
type Table struct {
	Delimiter  string
	SHA256     string
	Rows       []Row
	FileIssues []FileIssue
}

// HasFileError is true when the file as a whole is unusable.
func (t *Table) HasFileError() bool {
	for _, f := range t.FileIssues {
		if f.Severity == SevError {
			return true
		}
	}
	return false
}

func (t *Table) fail(code, message, column string) *Table {
	t.FileIssues = append(t.FileIssues, FileIssue{Severity: SevError, Code: code, Message: message, Column: column})
	return t
}

func (t *Table) warn(code, message, column string) {
	t.FileIssues = append(t.FileIssues, FileIssue{Severity: SevWarning, Code: code, Message: message, Column: column})
}

// Read parses raw CSV bytes. It never panics and never returns nil; file-level problems
// are reported in Table.FileIssues (check HasFileError before using Rows).
func Read(data []byte, spec Spec) *Table {
	sum := sha256.Sum256(data)
	t := &Table{Delimiter: ",", SHA256: hex.EncodeToString(sum[:]), FileIssues: []FileIssue{}}
	if len(data) > MaxBytes {
		return t.fail("file_too_large", "file lebih besar dari 16 MiB", "")
	}
	data = bytes.TrimPrefix(data, utf8BOM)
	if !utf8.Valid(data) {
		return t.fail("invalid_encoding", "file bukan UTF-8: simpan sebagai \"CSV UTF-8\" dari Excel lalu coba lagi", "")
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return t.fail("empty_file", "file kosong", "")
	}
	delim := detectDelimiter(string(data))
	t.Delimiter = string(delim)
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = delim
	r.FieldsPerRecord = -1
	r.LazyQuotes = false

	header, err := r.Read()
	if err != nil {
		return t.failParse(err)
	}
	for len(header) > 0 && strings.TrimSpace(header[len(header)-1]) == "" {
		header = header[:len(header)-1]
	}
	if len(header) > MaxCols {
		return t.fail("too_many_columns", fmt.Sprintf("terlalu banyak kolom (maksimum %d)", MaxCols), "")
	}
	colKey := t.mapHeader(header, spec)
	if t.HasFileError() {
		return t
	}

	for {
		rec, err := r.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Rows = nil
			return t.failParse(err)
		}
		if blankRecord(rec) {
			continue
		}
		line, _ := r.FieldPos(0)
		if len(t.Rows) >= MaxRows {
			t.Rows = nil
			return t.fail("too_many_rows", fmt.Sprintf("terlalu banyak baris (maksimum %d)", MaxRows), "")
		}
		t.Rows = append(t.Rows, buildRow(len(t.Rows)+1, line, rec, header, colKey, spec))
	}
	if len(t.Rows) == 0 {
		t.fail("no_data_rows", "file hanya berisi judul kolom, tidak ada baris data", "")
	}
	return t
}

func (t *Table) failParse(err error) *Table {
	var pe *csv.ParseError
	if errors.As(err, &pe) {
		reason := pe.Err.Error()
		switch {
		case errors.Is(pe.Err, csv.ErrBareQuote):
			reason = "tanda kutip (\") muncul di tengah kolom yang tidak diapit tanda kutip"
		case errors.Is(pe.Err, csv.ErrQuote):
			reason = "tanda kutip tidak ditutup atau salah tempat"
		}
		return t.fail("bad_csv", fmt.Sprintf("format CSV tidak valid pada baris %d, kolom %d: %s", pe.Line, pe.Column, reason), "")
	}
	return t.fail("bad_csv", "format CSV tidak valid: "+err.Error(), "")
}

// mapHeader resolves header cells to canonical keys, reporting unknown/ignored columns
// (warnings) and missing required or duplicate columns (errors). The result maps
// column index -> canonical key.
func (t *Table) mapHeader(header []string, spec Spec) map[int]string {
	byName := map[string]string{}
	for _, c := range spec.Columns {
		byName[normHeader(c.Key)] = c.Key
		for _, a := range c.Aliases {
			byName[normHeader(a)] = c.Key
		}
	}
	ignored := map[string]bool{}
	for _, n := range spec.Ignored {
		ignored[normHeader(n)] = true
	}
	colKey := map[int]string{}
	seen := map[string]bool{}
	for i, h := range header {
		n := normHeader(h)
		if n == "" {
			continue
		}
		if key, ok := byName[n]; ok {
			if seen[key] {
				t.fail("duplicate_header", fmt.Sprintf("kolom \"%s\" muncul lebih dari sekali", key), key)
				continue
			}
			seen[key] = true
			colKey[i] = key
			continue
		}
		if ignored[n] {
			t.warn("ignored_column", fmt.Sprintf("kolom \"%s\" diabaikan (tidak diimpor)", strings.TrimSpace(h)), strings.TrimSpace(h))
			continue
		}
		t.warn("unknown_column", fmt.Sprintf("kolom \"%s\" tidak dikenal dan diabaikan", strings.TrimSpace(h)), strings.TrimSpace(h))
	}
	for _, c := range spec.Columns {
		if c.Required && !seen[c.Key] {
			t.fail("missing_column", fmt.Sprintf("kolom wajib \"%s\" tidak ada", c.Key), c.Key)
		}
	}
	return colKey
}

func buildRow(index, line int, rec, header []string, colKey map[int]string, spec Spec) Row {
	row := Row{Index: index, Line: line, Cells: make(map[string]string, len(spec.Columns))}
	for _, c := range spec.Columns {
		row.Cells[c.Key] = ""
	}
	for i, key := range colKey {
		if i < len(rec) {
			row.Cells[key] = cleanCell(rec[i])
		}
	}
	if len(rec) < len(header) {
		row.Problems = append(row.Problems, Issue{Row: index, Line: line, Severity: SevError, Code: "short_row",
			Message: fmt.Sprintf("baris hanya punya %d kolom, judul punya %d", len(rec), len(header))})
	}
	for i := len(header); i < len(rec); i++ {
		if strings.TrimSpace(rec[i]) != "" {
			row.Problems = append(row.Problems, Issue{Row: index, Line: line, Severity: SevError, Code: "extra_fields",
				Message: fmt.Sprintf("baris punya %d kolom, judul hanya %d (kolom berlebih berisi data)", len(rec), len(header))})
			break
		}
	}
	return row
}

// formulaLead lists the leading bytes a spreadsheet may treat as a formula. GuardCell
// prefixes them with an apostrophe on export and cleanCell strips that on import; both
// use this one set so a guarded value always round-trips.
const formulaLead = "=+-@\t\r"

// cleanCell reverses the export's formula guard (exactly one leading apostrophe before
// = + - @ tab CR) and normalises blanks: an all-whitespace cell and a lone "-" (the
// export's guarded placeholder) are empty.
func cleanCell(s string) string {
	if len(s) >= 2 && s[0] == '\'' && strings.IndexByte(formulaLead, s[1]) >= 0 {
		s = s[1:]
	}
	if t := strings.TrimSpace(s); t == "" || t == "-" {
		return ""
	}
	return s
}

// GuardCell is the export's formula guard (the inverse of cleanCell's reversal): a cell
// that starts with = + - @ tab or CR gets one leading apostrophe so a spreadsheet does
// not run it as a formula.
func GuardCell(s string) string {
	if s != "" && strings.IndexByte(formulaLead, s[0]) >= 0 {
		return "'" + s
	}
	return s
}

func blankRecord(rec []string) bool {
	for _, c := range rec {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}

// normHeader lower-cases and drops whitespace, '_', '-' and '.' so "Total Belanja",
// "total_belanja" and "TOTAL-BELANJA" are one name.
func normHeader(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch r {
		case ' ', '\t', '_', '-', '.', 0xA0, 0xFEFF: // 0xA0 NBSP, 0xFEFF BOM
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// detectDelimiter votes among , ; and tab on the first record, ignoring quoted text.
func detectDelimiter(s string) rune {
	counts := map[byte]int{}
	inQuote := false
scan:
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '"':
			inQuote = !inQuote
		case inQuote:
		case c == '\n' || c == '\r':
			break scan
		case c == ',' || c == ';' || c == '\t':
			counts[c]++
		}
	}
	best, bestN := byte(','), counts[',']
	for _, d := range []byte{';', '\t'} {
		if counts[d] > bestN {
			best, bestN = d, counts[d]
		}
	}
	return rune(best)
}
