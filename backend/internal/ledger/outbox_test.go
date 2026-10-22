package ledger

import (
	"regexp"
	"testing"
)

func TestOutboxRowForKeepsSourceRefID(t *testing.T) {
	doc := baseDoc()
	doc.RefID, doc.RefNumber = "00000000-0000-4000-8000-0000000000aa", "KMG-AB0004"
	r := outboxRowFor(doc, DocumentID(doc.Key, 0), 0, 1)
	if r.refID != doc.RefID || r.refNumber != "KMG-AB0004" || r.part != 0 || r.partCount != 1 {
		t.Fatalf("row = %+v", r)
	}
	if r.kind != "sale" || r.locationType != "outlet" || r.docKey != "sale:o1" {
		t.Fatalf("header = %+v", r)
	}
}

func TestOutboxRowForBackfillSharesPartZeroIDAcrossParts(t *testing.T) {
	doc := baseDoc()
	doc.Key, doc.Kind, doc.RefType = "opening:r1:outlet:x", KindOpening, "backfill"
	p1 := outboxRowFor(doc, DocumentID(doc.Key, 1), 1, 3)
	p3 := outboxRowFor(doc, DocumentID(doc.Key, 3), 3, 3)
	want := DocumentID(doc.Key, 0)
	if p1.refID != want || p3.refID != want {
		t.Fatalf("ref ids %s %s, want shared %s", p1.refID, p3.refID, want)
	}
	if p1.documentID == p3.documentID || p1.documentID == want {
		t.Fatal("each part needs its own document id, distinct from the part-0 id")
	}
	if p3.part != 3 || p3.partCount != 3 {
		t.Fatalf("part %d/%d", p3.part, p3.partCount)
	}
}

func TestOutboxRowArgsMatchEnqueuePlaceholders(t *testing.T) {
	n := len(regexp.MustCompile(`\$\d+`).FindAllString(enqueueOutboxSQL, -1))
	if got := len((outboxRow{}).args()); got != 10 {
		t.Fatalf("args = %d, want 10", got)
	}
	if n != 11 { // $1 appears twice ($1 in VALUES and in the EXISTS guard)
		t.Fatalf("enqueue SQL has %d placeholders, want 11", n)
	}
	if (outboxRow{}).args()[7] != nil {
		t.Fatal("empty ref number must be NULL")
	}
}
