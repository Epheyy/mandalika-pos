package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/csvimport"
)

func postImport(t *testing.T, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	// Write is nil on purpose: every case here must be refused before the repository.
	h := &Handlers{importSlots: make(chan struct{}, maxConcurrentImports)}
	r := httptest.NewRequest(http.MethodPost, "/customers/import", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ImportCustomers(w, r)
	return w
}

func TestImportRefusesBadRequestsBeforeTheRepository(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		headers map[string]string
		want    int
	}{
		{"malformed JSON", `{`, nil, http.StatusBadRequest},
		{"unknown field", `{"csv":"x","dryRun":true,"bogus":1}`, nil, http.StatusBadRequest},
		{"commit without Idempotency-Key", `{"csv":"x","dryRun":false,"fileSha256":"a","expectedSummary":{"create":0,"update":0,"skip":0,"error":0,"warning":0,"newCategories":0}}`, nil, http.StatusBadRequest},
		{"commit with blank key", `{"csv":"x","dryRun":false,"fileSha256":"a","expectedSummary":{"create":0,"update":0,"skip":0,"error":0,"warning":0,"newCategories":0}}`, map[string]string{"Idempotency-Key": "  "}, http.StatusBadRequest},
		{"commit without preview hash", `{"csv":"x","dryRun":false,"expectedSummary":{"create":0,"update":0,"skip":0,"error":0,"warning":0,"newCategories":0}}`, map[string]string{"Idempotency-Key": "k"}, http.StatusBadRequest},
		{"commit without preview summary", `{"csv":"x","dryRun":false,"fileSha256":"a"}`, map[string]string{"Idempotency-Key": "k"}, http.StatusBadRequest},
		{"body over the cap", `{"csv":"` + strings.Repeat("a", importBodyCap) + `","dryRun":true}`, nil, http.StatusRequestEntityTooLarge},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := postImport(t, c.body, c.headers)
			if w.Code != c.want {
				t.Fatalf("status %d want %d body %s", w.Code, c.want, w.Body.String()[:min(200, w.Body.Len())])
			}
		})
	}
}

func TestImportBeyondTheConcurrencyLimitIs429(t *testing.T) {
	h := &Handlers{importSlots: make(chan struct{}, maxConcurrentImports)}
	for i := 0; i < maxConcurrentImports; i++ {
		h.importSlots <- struct{}{} // every slot busy
	}
	r := httptest.NewRequest(http.MethodPost, "/customers/import", strings.NewReader(`{"csv":"x","dryRun":true}`))
	w := httptest.NewRecorder()
	h.ImportCustomers(w, r)
	if w.Code != http.StatusTooManyRequests || !strings.Contains(w.Body.String(), "sibuk") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	<-h.importSlots // a freed slot admits the request again (it then fails on the nil repo only if it got that far)
	w = httptest.NewRecorder()
	h.ImportCustomers(w, httptest.NewRequest(http.MethodPost, "/customers/import", strings.NewReader(`{`)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("freed slot: %d", w.Code)
	}
}

// The handler marshals csvimport.Report directly; this keeps it field-for-field equal to
// the generated OpenAPI type so the wire contract cannot drift unnoticed.
func TestImportReportMatchesGeneratedContract(t *testing.T) {
	table := csvimport.Read([]byte("Nama,Telepon\nA,0811111111\nB,\n"), csvimport.CustomerSpec)
	plan, err := csvimport.PlanCustomers(table, func([]string) (map[string]int, error) { return nil, nil })
	if err != nil {
		t.Fatal(err)
	}
	plan.Report.RunID, plan.Report.AppliedAt = "r1", "2026-10-16T00:00:00Z"
	raw, err := json.Marshal(plan.Report)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var wire api.ImportReport
	if err := dec.Decode(&wire); err != nil {
		t.Fatalf("report no longer fits api.ImportReport: %v", err)
	}
	back, _ := json.Marshal(wire)
	var a, b map[string]any
	_ = json.Unmarshal(raw, &a)
	_ = json.Unmarshal(back, &b)
	if len(a) != len(b) {
		t.Errorf("fields lost in the generated type: %v vs %v", a, b)
	}
	for _, k := range []string{"kind", "delimiter", "fileSha256", "totalRows", "summary", "fileIssues", "issues", "rows"} {
		if _, ok := a[k]; !ok {
			t.Errorf("required field %q missing from the report JSON", k)
		}
	}
	if a["fileIssues"] == nil || a["issues"] == nil || a["rows"] == nil {
		t.Error("empty lists must be [] not null")
	}
}
