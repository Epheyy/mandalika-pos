package fixture

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type receiptServer struct {
	called bool
	id     int
	params GetReceiptParams
}

func (s *receiptServer) GetReceipt(w http.ResponseWriter, r *http.Request, id int, params GetReceiptParams) {
	s.called = true
	s.id = id
	s.params = params
	w.WriteHeader(204)
}

func TestRequiredBindings(t *testing.T) {
	cases := []struct {
		name, path, query, header, cookie string
		code                              int
	}{
		{"present", "2", "qty=3", "4", "5", 204},
		{"zero", "0", "qty=0", "0", "0", 204},
		{"path-absent", "", "qty=3", "4", "5", 404},
		{"path-malformed", "no", "qty=3", "4", "5", 400},
		{"query-absent", "2", "", "4", "5", 400},
		{"query-empty", "2", "qty=", "4", "5", 400},
		{"query-malformed", "2", "qty=no", "4", "5", 400},
		{"header-absent", "2", "qty=3", "__absent__", "5", 400},
		{"header-empty", "2", "qty=3", "", "5", 400},
		{"header-malformed", "2", "qty=3", "no", "5", 400},
		{"cookie-absent", "2", "qty=3", "4", "__absent__", 400},
		{"cookie-empty", "2", "qty=3", "4", "", 400},
		{"cookie-malformed", "2", "qty=3", "4", "no", 400},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := &receiptServer{}
			r := httptest.NewRequest("GET", "/receipts/"+c.path+"?"+c.query, nil)
			if c.header != "__absent__" {
				r.Header.Set("X-Count", c.header)
			}
			if c.cookie != "__absent__" {
				r.AddCookie(&http.Cookie{Name: "run", Value: c.cookie})
			}
			w := httptest.NewRecorder()
			Handler(s).ServeHTTP(w, r)
			if w.Code != c.code {
				t.Fatalf("status=%d expected=%d body=%s called=%v", w.Code, c.code, w.Body.String(), s.called)
			}
			if s.called != (c.code == 204) {
				t.Fatalf("unexpected handler dispatch=%v", s.called)
			}
			if c.name == "zero" && (s.id != 0 || s.params.Qty != 0 || s.params.XCount != 0 || s.params.Run != 0) {
				t.Fatal("zero changed")
			}
		})
	}
}

func TestTypedRoundTrip(t *testing.T) {
	for _, suffix := range []string{"", `,"optional":null`, `,"optional":""`} {
		t.Run(suffix, func(t *testing.T) {
			input := `{"name":"香水","count":0,"kind":"香水","amount":0,"tags":[],"extras":{"owned":0},"combined":"ok","union":{"method":"cash","received":0}` + suffix + `}`
			var v Receipt
			if err := json.Unmarshal([]byte(input), &v); err != nil {
				t.Fatal(err)
			}
			if v.Name != "香水" || v.Count != 0 || v.Amount == nil || *v.Amount != 0 || v.Extras == nil || (*v.Extras)["owned"] != 0 {
				t.Fatal("typed fields changed")
			}
			cash, err := v.Union.AsCash()
			if err != nil || cash.Received == nil || *cash.Received != 0 {
				t.Fatalf("union=%+v err=%v", cash, err)
			}
			b, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			if suffix == "" && strings.Contains(string(b), `"optional"`) {
				t.Fatal("absent became present")
			}
			if suffix != "" && !strings.Contains(string(b), strings.TrimPrefix(suffix, ",")) {
				t.Fatalf("nullable changed: %s", b)
			}
		})
	}
}

func TestResponseWriters(t *testing.T) {
	w := httptest.NewRecorder()
	r := GetReceipt200JSONResponse{Count: 0, Name: "香水", Kind: Scent}
	if err := r.VisitGetReceiptResponse(w); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/json" || !strings.Contains(w.Body.String(), "香水") {
		t.Fatal("JSON response changed")
	}
	w = httptest.NewRecorder()
	if err := (GetReceipt204Response{}).VisitGetReceiptResponse(w); err != nil {
		t.Fatal(err)
	}
	if w.Code != 204 || w.Body.Len() != 0 {
		t.Fatal("empty response changed")
	}
}
