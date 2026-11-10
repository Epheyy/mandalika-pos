package read

import (
	"errors"
	"testing"
)

// fakeRows is a pgx-free stand-in for pgx.Rows: each row is (raw, total); raw nil = SQL NULL.
type fakeRows struct {
	raws   [][]byte
	totals []int
	i      int
	err    error
}

func (f *fakeRows) Next() bool { f.i++; return f.i <= len(f.raws) }
func (f *fakeRows) Err() error { return f.err }
func (f *fakeRows) Scan(dest ...any) error {
	*(dest[0].(*[]byte)) = f.raws[f.i-1]
	*(dest[1].(*int)) = f.totals[f.i-1]
	return nil
}

type tinyRow struct {
	ID string `json:"id"`
}

func TestPagedJSONSkipsNullRowAndKeepsTotal(t *testing.T) {
	rows := &fakeRows{raws: [][]byte{nil}, totals: []int{137}}
	out, total, err := decodePaged[tinyRow](rows)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 0 || total != 137 {
		t.Fatalf("want 0 rows and total 137, got %d rows total %d", len(out), total)
	}
	if out == nil {
		t.Fatal("empty page must be a non-nil slice (serialises as [], not null)")
	}
}

func TestPagedJSONDecodesRowsInOrder(t *testing.T) {
	rows := &fakeRows{raws: [][]byte{[]byte(`{"id":"b"}`), []byte(`{"id":"a"}`)}, totals: []int{9, 9}}
	out, total, err := decodePaged[tinyRow](rows)
	if err != nil || total != 9 || len(out) != 2 || out[0].ID != "b" || out[1].ID != "a" {
		t.Fatalf("got %+v total %d err %v", out, total, err)
	}
}

func TestPagedJSONEmptyResultIsZero(t *testing.T) {
	out, total, err := decodePaged[tinyRow](&fakeRows{})
	if err != nil || total != 0 || len(out) != 0 || out == nil {
		t.Fatalf("got %+v total %d err %v", out, total, err)
	}
}

func TestPagedJSONSurfacesRowsError(t *testing.T) {
	boom := errors.New("boom")
	_, _, err := decodePaged[tinyRow](&fakeRows{err: boom})
	if !errors.Is(err, boom) {
		t.Fatalf("want boom, got %v", err)
	}
}
