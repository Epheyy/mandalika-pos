package erpstub

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"testing"
	"time"
)

type catItem struct {
	Slug      string     `json:"slug"`
	Code      string     `json:"code"`
	DeletedAt *time.Time `json:"deleted_at"`
}

type catPage struct {
	Items      []catItem `json:"items"`
	NextCursor *string   `json:"next_cursor"`
	ServerTime string    `json:"server_time"`
}

func getPage(t *testing.T, e *env, target string) catPage {
	t.Helper()
	rec := e.get(target)
	expectStatus(t, rec, http.StatusOK)
	r := decode(t, rec)
	if r.Status != "success" {
		t.Fatalf("status field = %q", r.Status)
	}
	var p catPage
	if err := json.Unmarshal(r.Data, &p); err != nil {
		t.Fatal(err)
	}
	if p.ServerTime == "" {
		t.Fatal("server_time missing")
	}
	return p
}

func slugsOf(items []catItem) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it.Slug)
	}
	return out
}

const fgPath = "/api/integration/v1/catalog/finished-goods"

func TestCatalogFullPagingIsKeysetStable(t *testing.T) {
	e := newEnv(t, "")
	p1 := getPage(t, e, fgPath+"?take=2")
	if p1.NextCursor == nil {
		t.Fatal("page 1 should have a next cursor")
	}
	e.clock.Advance(time.Hour)
	body := `{"slug":"fg-000-early","code":"FG-000","name":"Early"}`
	expectStatus(t, e.postHook("/_stub/fg", []byte(body)), http.StatusOK)

	p2 := getPage(t, e, fgPath+"?take=2&cursor="+url.QueryEscape(*p1.NextCursor))
	if p2.NextCursor == nil {
		t.Fatal("page 2 should have a next cursor")
	}
	p3 := getPage(t, e, fgPath+"?take=2&cursor="+url.QueryEscape(*p2.NextCursor))
	if p3.NextCursor != nil {
		t.Fatal("last page must have null next_cursor")
	}
	got := append(append(slugsOf(p1.Items), slugsOf(p2.Items)...), slugsOf(p3.Items)...)
	want := []string{"fg-001-santal-noir", "fg-002-rose-oud", "fg-003-amber-musk", "fg-004-vetiver-sage", "fg-005-old-classic"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("walk = %v, want %v", got, want)
	}
}

func TestCatalogIncrementalOrderAndCursorModes(t *testing.T) {
	e := newEnv(t, "")
	since := "?updated_since=2025-01-01T00:00:00Z"
	all := getPage(t, e, fgPath+since)
	want := []string{"fg-001-santal-noir", "fg-003-amber-musk", "fg-002-rose-oud", "fg-005-old-classic", "fg-004-vetiver-sage", "fg-006-retired-blend"}
	if !reflect.DeepEqual(slugsOf(all.Items), want) {
		t.Fatalf("incremental = %v, want %v", slugsOf(all.Items), want)
	}
	if all.Items[5].DeletedAt == nil {
		t.Fatal("tombstone should be included in incremental mode")
	}

	var walked []string
	target := fgPath + since + "&take=2"
	for pages := 0; pages < 10; pages++ {
		p := getPage(t, e, target)
		walked = append(walked, slugsOf(p.Items)...)
		if p.NextCursor == nil {
			break
		}
		target = fgPath + since + "&take=2&cursor=" + url.QueryEscape(*p.NextCursor)
	}
	if !reflect.DeepEqual(walked, want) {
		t.Fatalf("paged incremental = %v", walked)
	}

	full := getPage(t, e, fgPath+"?take=1")
	expectValidation(t, e.get(fgPath+since+"&cursor="+url.QueryEscape(*full.NextCursor)))
}

func TestCatalogParamErrors(t *testing.T) {
	e := newEnv(t, "")
	for _, q := range []string{
		"?take=0", "?take=501", "?take=abc",
		"?updated_since=2026-01-01T00:00:00+00:00", // '+' decodes to a space
		"?cursor=!!!!", "?codes=", "?codes=A,A", "?search=",
	} {
		expectValidation(t, e.get(fgPath+q))
	}
	p := getPage(t, e, "/api/integration/v1/catalog/outlets")
	if !reflect.DeepEqual(slugsOf(p.Items), []string{"bsd", "kemang"}) {
		t.Fatalf("outlets = %v", slugsOf(p.Items))
	}
}

func TestCatalogFilters(t *testing.T) {
	e := newEnv(t, "")
	p := getPage(t, e, fgPath+"?codes=FG-002,FG-004")
	if !reflect.DeepEqual(slugsOf(p.Items), []string{"fg-002-rose-oud", "fg-004-vetiver-sage"}) {
		t.Fatalf("codes filter = %v", slugsOf(p.Items))
	}
	p = getPage(t, e, fgPath+"?search=ROSE")
	if len(p.Items) != 1 || p.Items[0].Code != "FG-002" {
		t.Fatalf("search = %v", slugsOf(p.Items))
	}
}

const kmgStock = "/api/integration/v1/outlets/KMG/stock"

func getStock(t *testing.T, e *env, target string) stockPage {
	t.Helper()
	rec := e.get(target)
	expectStatus(t, rec, http.StatusOK)
	var p stockPage
	if err := json.Unmarshal(decode(t, rec).Data, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestOutletStock(t *testing.T) {
	e := newEnv(t, "")
	expectStatus(t, e.post(fixture(t, "doc_opening.json")), http.StatusOK)
	stockDoc := docBody(1, "adjust", ln(1, "FG-003", 5), ln(2, "FG-004", 0))
	expectStatus(t, e.post(mustJSON(t, stockDoc)), http.StatusOK)

	all := getStock(t, e, kmgStock)
	if len(all.Items) != 2 || all.Items[0].FgCode != "FG-001" || all.Items[1].FgCode != "FG-003" {
		t.Fatalf("positive stock = %+v", all.Items)
	}
	if all.LastUpdatedAt == nil || all.Outlet.Slug != "kemang" {
		t.Fatalf("outlet/last_updated_at wrong: %+v", all)
	}

	coded := getStock(t, e, kmgStock+"?fg_codes=FG-001,FG-002")
	if len(coded.Items) != 2 || coded.Items[1].FgCode != "FG-002" || coded.Items[1].Qty != 0 || coded.Items[1].UpdatedAt != nil {
		t.Fatalf("fg_codes stock = %+v", coded.Items)
	}
	expectValidation(t, e.get(kmgStock+"?fg_codes=FG-001&take=1"))
	expectValidation(t, e.get(kmgStock+"?fg_codes=FG-NOPE"))
	expectValidation(t, e.get(kmgStock+"?fg_codes=FG-006"))
	rec := e.get("/api/integration/v1/outlets/ZZZ/stock")
	expectStatus(t, rec, http.StatusNotFound)
	if decode(t, rec).Code != "NOT_FOUND" {
		t.Fatalf("body = %s", rec.Body.String())
	}

	p1 := getStock(t, e, kmgStock+"?take=1")
	if len(p1.Items) != 1 || p1.NextCursor == nil || p1.Items[0].FgCode != "FG-001" {
		t.Fatalf("page 1 = %+v", p1)
	}
	p2 := getStock(t, e, kmgStock+"?take=1&cursor="+url.QueryEscape(*p1.NextCursor))
	if len(p2.Items) != 1 || p2.NextCursor != nil || p2.Items[0].FgCode != "FG-003" {
		t.Fatalf("page 2 = %+v", p2)
	}
}

func TestStubFGUpsertFeedsCatalogAndDocuments(t *testing.T) {
	e := newEnv(t, "")
	e.clock.Advance(24 * time.Hour)
	rec := e.postHook("/_stub/fg", []byte(`{"slug":"fg-new","code":"FG-NEW","name":"Brand New"}`))
	expectStatus(t, rec, http.StatusOK)
	var fg struct {
		Gender, Status string
	}
	_ = json.Unmarshal(decode(t, rec).Data, &fg)
	if fg.Gender != "UNISEX" || fg.Status != "ACTIVE" {
		t.Fatalf("defaults = %+v", fg)
	}

	p := getPage(t, e, fgPath+"?updated_since=2026-03-10T08:00:00Z")
	if len(p.Items) != 1 || p.Items[0].Code != "FG-NEW" {
		t.Fatalf("incremental after old watermark = %v", slugsOf(p.Items))
	}
	expectStatus(t, e.post(mustJSON(t, docBody(1, "receipt", ln(1, "FG-NEW", 3)))), http.StatusOK)

	dup := e.postHook("/_stub/fg", []byte(`{"slug":"fg-other","code":"FG-NEW","name":"Dup"}`))
	expectValidation(t, dup)

	tomb := e.postHook("/_stub/fg", []byte(`{"slug":"fg-new","code":"FG-NEW","name":"Brand New","deleted_at":"2026-06-02T00:00:00Z"}`))
	expectStatus(t, tomb, http.StatusOK)
	// Like the ERP (BR7), a stock document may still name an FG in trash.
	expectStatus(t, e.post(mustJSON(t, docBody(2, "receipt", ln(2, "FG-NEW", 1)))), http.StatusOK)
}

func TestStubOutletUpsertTombstoneAndCodeRules(t *testing.T) {
	e := newEnv(t, "")
	e.clock.Advance(24 * time.Hour)
	rec := e.postHook("/_stub/outlet", []byte(`{"slug":"pik","code":"PIK","name":"Mandalika PIK"}`))
	expectStatus(t, rec, http.StatusOK)
	var o struct {
		Type      string `json:"type"`
		CreatedAt string `json:"created_at"`
		UpdatedAt string `json:"updated_at"`
	}
	_ = json.Unmarshal(decode(t, rec).Data, &o)
	if o.Type != "RETAIL" || o.CreatedAt != "2026-06-02T00:00:00Z" || o.UpdatedAt != o.CreatedAt {
		t.Fatalf("defaults/stamps = %+v", o)
	}

	// A code already used by another slug is rejected; an invalid type too.
	expectValidation(t, e.postHook("/_stub/outlet", []byte(`{"slug":"other","code":"PIK","name":"Dup"}`)))
	expectValidation(t, e.postHook("/_stub/outlet", []byte(`{"slug":"pik","code":"PIK","name":"X","type":"BOGUS"}`)))

	// A code change on the same slug keeps created_at and bumps updated_at.
	e.clock.Advance(time.Hour)
	chg := e.postHook("/_stub/outlet", []byte(`{"slug":"pik","code":"PIK2","name":"Mandalika PIK"}`))
	expectStatus(t, chg, http.StatusOK)
	_ = json.Unmarshal(decode(t, chg).Data, &o)
	if o.CreatedAt != "2026-06-02T00:00:00Z" || o.UpdatedAt != "2026-06-02T01:00:00Z" {
		t.Fatalf("created_at must be kept, updated_at bumped: %+v", o)
	}

	// deleted_at tombstones: gone from a full read, present in an incremental one.
	tomb := e.postHook("/_stub/outlet", []byte(`{"slug":"pik","code":"PIK2","name":"Mandalika PIK","deleted_at":"2026-06-02T02:00:00Z"}`))
	expectStatus(t, tomb, http.StatusOK)
	for _, it := range getPage(t, e, "/api/integration/v1/catalog/outlets").Items {
		if it.Slug == "pik" {
			t.Fatal("tombstoned outlet must not appear in a full read")
		}
	}
	found := false
	for _, it := range getPage(t, e, "/api/integration/v1/catalog/outlets?updated_since=2026-06-01T00:00:00Z").Items {
		found = found || it.Slug == "pik"
	}
	if !found {
		t.Fatal("tombstone must appear in an incremental read")
	}
}
