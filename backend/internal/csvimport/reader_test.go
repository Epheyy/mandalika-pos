package csvimport

import (
	"bytes"
	"encoding/csv"
	"os"
	"strings"
	"testing"
)

var testSpec = Spec{
	Columns: []ColumnSpec{
		{Key: "Nama", Required: true},
		{Key: "Telepon", Required: true},
		{Key: "Catatan"},
	},
	Ignored: []string{"Poin"},
}

func codes(fs []FileIssue, sev string) []string {
	var out []string
	for _, f := range fs {
		if f.Severity == sev {
			out = append(out, f.Code)
		}
	}
	return out
}

func hasCode(fs []FileIssue, code string) bool {
	for _, f := range fs {
		if f.Code == code {
			return true
		}
	}
	return false
}

func TestReadRFC4180Matrix(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want [][3]string // Nama, Telepon, Catatan
	}{
		{"commas and doubled quotes", "Nama,Telepon,Catatan\n\"Melati, Putih\",0811111,\"say \"\"hi\"\"\"\n",
			[][3]string{{"Melati, Putih", "0811111", `say "hi"`}}},
		{"CRLF", "Nama,Telepon,Catatan\r\nA,0811111,x\r\nB,0822222,y\r\n",
			[][3]string{{"A", "0811111", "x"}, {"B", "0822222", "y"}}},
		{"LF without trailing newline", "Nama,Telepon,Catatan\nA,0811111,x",
			[][3]string{{"A", "0811111", "x"}}},
		{"embedded newline", "Nama,Telepon,Catatan\nA,0811111,\"l1\nl2\"\nB,0822222,\n",
			[][3]string{{"A", "0811111", "l1\nl2"}, {"B", "0822222", ""}}},
		{"embedded CRLF becomes LF", "Nama,Telepon,Catatan\r\nA,0811111,\"l1\r\nl2\"\r\n",
			[][3]string{{"A", "0811111", "l1\nl2"}}},
		{"unicode and emoji", "Nama,Telepon,Catatan\nNi Luh Äyu 香 🌺,0811111,ok\n",
			[][3]string{{"Ni Luh Äyu 香 🌺", "0811111", "ok"}}},
		{"empty cells", "Nama,Telepon,Catatan\nA,0811111,\n",
			[][3]string{{"A", "0811111", ""}}},
		{"trailing excel semicolons", "Nama;Telepon;Catatan;;;\nA;0811111;x;;;\n",
			[][3]string{{"A", "0811111", "x"}}},
		{"BOM and semicolon", "\xEF\xBB\xBFNama;Telepon;Catatan\nA;0811111;x\n",
			[][3]string{{"A", "0811111", "x"}}},
		{"tab delimited", "Nama\tTelepon\tCatatan\nA\t0811111\tx\n",
			[][3]string{{"A", "0811111", "x"}}},
		{"blank and all-delimiter lines are skipped", "Nama,Telepon,Catatan\n\n,,\nA,0811111,x\n",
			[][3]string{{"A", "0811111", "x"}}},
		{"free text is not trimmed but whitespace-only becomes empty", "Nama,Telepon,Catatan\nA,0811111,\"  spasi  \"\nB,0822222,\"   \"\n",
			[][3]string{{"A", "0811111", "  spasi  "}, {"B", "0822222", ""}}},
		{"apostrophe guard reversed", "Nama,Telepon,Catatan\n'=1+1,'+6281234,'-5000\n",
			[][3]string{{"=1+1", "+6281234", "-5000"}}},
		{"an apostrophe that does not guard a trigger is kept", "Nama,Telepon,Catatan\n'abc,0811111,''=x\n",
			[][3]string{{"'abc", "0811111", "''=x"}}},
		{"lone guarded minus is blank", "Nama,Telepon,Catatan\nA,0811111,'-\nB,0822222,-\n",
			[][3]string{{"A", "0811111", ""}, {"B", "0822222", ""}}},
		{"header aliases are case and space insensitive", "NAMA , telepon,  CATATAN\nA,0811111,x\n",
			[][3]string{{"A", "0811111", "x"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tb := Read([]byte(c.in), testSpec)
			if e := codes(tb.FileIssues, SevError); len(e) != 0 {
				t.Fatalf("unexpected file errors %v", tb.FileIssues)
			}
			if len(tb.Rows) != len(c.want) {
				t.Fatalf("rows=%d want %d (%v)", len(tb.Rows), len(c.want), tb.Rows)
			}
			for i, w := range c.want {
				got := [3]string{tb.Rows[i].Cells["Nama"], tb.Rows[i].Cells["Telepon"], tb.Rows[i].Cells["Catatan"]}
				if got != w {
					t.Errorf("row %d = %q want %q", i+1, got, w)
				}
				if len(tb.Rows[i].Problems) != 0 {
					t.Errorf("row %d problems %v", i+1, tb.Rows[i].Problems)
				}
			}
		})
	}
}

func TestReadDelimiterReported(t *testing.T) {
	for in, want := range map[string]string{
		"Nama,Telepon\nA,1\n":               ",",
		"Nama;Telepon\nA;1\n":               ";",
		"Nama\tTelepon\nA\t1\n":             "\t",
		"\"Na;ma\",Telepon\nA,1\n":          ",", // a ';' inside quotes does not vote
		"Nama\nA\n":                         ",", // single column
		"Nama;Telepon,Catatan;x\nA;1,2;3\n": ";",
	} {
		tb := Read([]byte(in), Spec{Columns: []ColumnSpec{{Key: "Nama"}}})
		if tb.Delimiter != want {
			t.Errorf("delimiter for %q = %q want %q", in, tb.Delimiter, want)
		}
	}
}

func TestReadLineNumbers(t *testing.T) {
	in := "Nama,Telepon,Catatan\nA,0811111,\"l1\nl2\"\n\nB,0822222,x\n"
	tb := Read([]byte(in), testSpec)
	if len(tb.Rows) != 2 {
		t.Fatalf("rows=%d", len(tb.Rows))
	}
	if tb.Rows[0].Line != 2 || tb.Rows[0].Index != 1 {
		t.Errorf("row1 line=%d idx=%d want 2/1 (multiline record reports its first line)", tb.Rows[0].Line, tb.Rows[0].Index)
	}
	if tb.Rows[1].Line != 5 || tb.Rows[1].Index != 2 {
		t.Errorf("row2 line=%d idx=%d want 5/2 (physical line after embedded newline and blank line)", tb.Rows[1].Line, tb.Rows[1].Index)
	}
}

func TestReadFileLevelErrors(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		code string
	}{
		{"stray quote", []byte("Nama,Telepon\nA \"x\",0811\n"), "bad_csv"},
		{"unterminated quote", []byte("Nama,Telepon\n\"A,0811\n"), "bad_csv"},
		{"invalid utf-8", []byte("Nama,Telepon\n\xff\xfe,0811\n"), "invalid_encoding"},
		{"empty file", []byte(""), "empty_file"},
		{"whitespace only", []byte(" \n\n "), "empty_file"},
		{"header only", []byte("Nama,Telepon\n"), "no_data_rows"},
		{"missing required column", []byte("Nama,Catatan\nA,x\n"), "missing_column"},
		{"duplicate header", []byte("Nama,Telepon,nama\nA,1,B\n"), "duplicate_header"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tb := Read(c.in, testSpec)
			if !hasCode(tb.FileIssues, c.code) {
				t.Fatalf("want file issue %s, got %v", c.code, tb.FileIssues)
			}
			if !tb.HasFileError() {
				t.Fatal("must be a file error")
			}
		})
	}
}

func TestReadBadCSVReportsLineAndColumn(t *testing.T) {
	tb := Read([]byte("Nama,Telepon\nA,0811\nB \"x\",0822\n"), testSpec)
	var msg string
	for _, f := range tb.FileIssues {
		if f.Code == "bad_csv" {
			msg = f.Message
		}
	}
	if !strings.Contains(msg, "baris 3") {
		t.Errorf("message should name line 3: %q", msg)
	}
}

func TestReadInvalidUTF8Hint(t *testing.T) {
	tb := Read([]byte("Nama,Telepon\n\xe9,0811\n"), testSpec)
	if !hasCode(tb.FileIssues, "invalid_encoding") {
		t.Fatal(tb.FileIssues)
	}
	for _, f := range tb.FileIssues {
		if f.Code == "invalid_encoding" && !strings.Contains(f.Message, "CSV UTF-8") {
			t.Errorf("message must tell the user to save as CSV UTF-8: %q", f.Message)
		}
	}
}

func TestReadUnknownAndIgnoredColumnsAreWarnings(t *testing.T) {
	tb := Read([]byte("Nama,Telepon,Poin,Aneh\nA,0811,5,z\n"), testSpec)
	if tb.HasFileError() {
		t.Fatal(tb.FileIssues)
	}
	if !hasCode(tb.FileIssues, "ignored_column") || !hasCode(tb.FileIssues, "unknown_column") {
		t.Fatalf("want ignored_column + unknown_column warnings, got %v", tb.FileIssues)
	}
}

func TestReadShortAndLongRows(t *testing.T) {
	tb := Read([]byte("Nama,Telepon,Catatan\nA,0811\nB,0822,x,extra\nC,0833,y,\n"), testSpec)
	if len(tb.Rows) != 3 {
		t.Fatalf("rows=%d", len(tb.Rows))
	}
	if len(tb.Rows[0].Problems) != 1 || tb.Rows[0].Problems[0].Code != "short_row" || tb.Rows[0].Problems[0].Severity != SevError {
		t.Errorf("short row must be an error, got %v", tb.Rows[0].Problems)
	}
	if len(tb.Rows[1].Problems) != 1 || tb.Rows[1].Problems[0].Code != "extra_fields" {
		t.Errorf("non-empty extra field must be an error, got %v", tb.Rows[1].Problems)
	}
	if len(tb.Rows[2].Problems) != 0 {
		t.Errorf("empty trailing extra field is allowed (Excel), got %v", tb.Rows[2].Problems)
	}
}

func TestReadLimits(t *testing.T) {
	var b strings.Builder
	b.WriteString("Nama,Telepon\n")
	for i := 0; i < MaxRows+1; i++ {
		b.WriteString("A,0811111\n")
	}
	if tb := Read([]byte(b.String()), testSpec); !hasCode(tb.FileIssues, "too_many_rows") {
		t.Errorf("want too_many_rows, got %v", tb.FileIssues)
	}
	cols := make([]string, MaxCols+1)
	for i := range cols {
		cols[i] = "c" + strings.Repeat("x", i)
	}
	if tb := Read([]byte(strings.Join(cols, ",")+"\n"+strings.Repeat("1,", MaxCols)+"1\n"), testSpec); !hasCode(tb.FileIssues, "too_many_columns") {
		t.Errorf("want too_many_columns, got %v", tb.FileIssues)
	}
	big := bytes.Repeat([]byte("a"), MaxBytes+1)
	if tb := Read(big, testSpec); !hasCode(tb.FileIssues, "file_too_large") {
		t.Errorf("want file_too_large, got %v", tb.FileIssues)
	}
}

func TestReadHashIsOfRawBytes(t *testing.T) {
	a := Read([]byte("Nama,Telepon\nA,0811111\n"), testSpec)
	b := Read([]byte("Nama,Telepon\nA,0811111\n"), testSpec)
	c := Read([]byte("Nama,Telepon\nA,0811112\n"), testSpec)
	if a.SHA256 == "" || a.SHA256 != b.SHA256 || a.SHA256 == c.SHA256 {
		t.Errorf("hash a=%s b=%s c=%s", a.SHA256, b.SHA256, c.SHA256)
	}
}

// The golden file is produced by the TypeScript exporter (csvCell/buildCSV) and compared
// byte for byte there; parsing it here proves the two languages agree.
func TestReadGoldenExport(t *testing.T) {
	raw, err := os.ReadFile("testdata/export_golden.csv")
	if err != nil {
		t.Fatal(err)
	}
	spec := Spec{Columns: []ColumnSpec{{Key: "Nama", Required: true}, {Key: "Deskripsi"}, {Key: "Catatan"}, {Key: "Angka"}}}
	tb := Read(raw, spec)
	if tb.HasFileError() {
		t.Fatal(tb.FileIssues)
	}
	want := [][4]string{
		{"Melati, Putih", `say "hi"`, "a;b", "12345.5"},
		{"Mawar", "line1\nline2", "", "-3"},
		{"=1+1", "+6281234567", "-5000", "0"},
		{"-2+3", "- bahan alami", "", ""}, // the exported `-` placeholder imports as blank; `'- bahan alami` keeps its text
		{"Ni Luh Äyu 香 🌺", "@SUM(A1)", "x", "7"},
	}
	if len(tb.Rows) != len(want) {
		t.Fatalf("rows=%d", len(tb.Rows))
	}
	for i, w := range want {
		r := tb.Rows[i].Cells
		got := [4]string{r["Nama"], r["Deskripsi"], r["Catatan"], r["Angka"]}
		if got != w {
			t.Errorf("row %d = %q want %q", i+1, got, w)
		}
	}
}

func FuzzRead(f *testing.F) {
	f.Add([]byte("Nama,Telepon\nA,0811\n"))
	f.Add([]byte("\xef\xbb\xbfNama;Telepon\r\n\"A\";\"x\"\"\n\"\r\n"))
	f.Add([]byte("Nama\tTelepon\n'=1\t'-\n"))
	f.Fuzz(func(t *testing.T, data []byte) {
		tb := Read(data, testSpec) // must never panic
		if tb == nil {
			t.Fatal("nil table")
		}
	})
}

// encoding/csv write-then-read identity for arbitrary cells, the property Read relies on.
func FuzzCSVRoundTrip(f *testing.F) {
	f.Add("a", "b,c", "d\ne")
	f.Add(`q"uote`, "x;y", "\r\n")
	f.Fuzz(func(t *testing.T, a, b, c string) {
		for _, s := range []string{a, b, c} {
			if strings.ContainsRune(s, 0) || !validUTF8(s) {
				t.Skip()
			}
		}
		var buf bytes.Buffer
		w := csv.NewWriter(&buf)
		if err := w.Write([]string{a, b, c}); err != nil {
			t.Fatal(err)
		}
		w.Flush()
		r := csv.NewReader(&buf)
		rec, err := r.Read()
		if err != nil {
			t.Fatal(err)
		}
		norm := func(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }
		if rec[0] != norm(a) || rec[1] != norm(b) || rec[2] != norm(c) {
			t.Fatalf("round trip %q -> %q", []string{a, b, c}, rec)
		}
	})
}

func validUTF8(s string) bool { return strings.ToValidUTF8(s, "") == s }
