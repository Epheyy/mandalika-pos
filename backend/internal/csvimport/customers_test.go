package csvimport

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func lookupFrom(m map[string]int) CustomerPhoneLookup {
	return func(phones []string) (map[string]int, error) {
		out := map[string]int{}
		for _, p := range phones {
			if n, ok := m[p]; ok {
				out[p] = n
			}
		}
		return out, nil
	}
}

func planCustomers(t *testing.T, csv string, existing map[string]int) *CustomersPlan {
	t.Helper()
	tb := Read([]byte(csv), CustomerSpec)
	p, err := PlanCustomers(tb, lookupFrom(existing))
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func issueCodes(r Report, sev string) []string {
	var out []string
	for _, i := range r.Issues {
		if i.Severity == sev {
			out = append(out, i.Code)
		}
	}
	return out
}

func TestPlanCustomersCreatesSkipsAndWarns(t *testing.T) {
	csv := "Nama,Telepon,Email,Tanggal Lahir,Anniversary,Catatan\n" +
		"Ayu,0811-1111-111,ayu@x.co,17/05/1990,2020-01-02,VIP\n" + // create
		"Budi,081222222222,,,,\n" + // exists once -> skip
		"Cici,081233333333,,,,\n" + // exists twice -> skip + warning
		"Dewi,812444444,,,,\n" // create, warning leading zero
	p := planCustomers(t, csv, map[string]int{"081222222222": 1, "081233333333": 2})
	r := p.Report
	if r.Summary.Create != 2 || r.Summary.Skip != 2 || r.Summary.Error != 0 {
		t.Fatalf("summary %+v", r.Summary)
	}
	if len(p.Creates) != 2 || p.Creates[0].Phone != "08111111111" || p.Creates[0].Birthday != "1990-05-17" || p.Creates[0].Anniversary != "2020-01-02" || p.Creates[0].Notes != "VIP" {
		t.Fatalf("creates %+v", p.Creates)
	}
	if r.Summary.Warning != 2 {
		t.Errorf("want 2 warnings (multiple matches, leading zero), got %d: %v", r.Summary.Warning, r.Issues)
	}
	reasons := map[string]string{}
	for _, row := range r.Rows {
		reasons[row.Key] = row.Action + ":" + row.Reason
	}
	if !strings.HasPrefix(reasons["081222222222"], "skip:pelanggan sudah ada") {
		t.Errorf("existing phone must be skipped with a reason: %v", reasons)
	}
	if r.HasErrors() {
		t.Error("no errors expected")
	}
}

func TestPlanCustomersRowErrors(t *testing.T) {
	csv := "Nama,Telepon,Email,Tanggal Lahir,Anniversary,Catatan\n" +
		",0811111111,,,,\n" + // no name
		"A,,,,,\n" + // no phone
		"B,6.28E+11,,,,\n" + // scientific
		"C,abc123,,,,\n" + // not a phone
		"D,0811222333,not-an-email,,,\n" + // warning only
		"E,0811222334,,31/02/2020,,\n" + // bad date
		"F,0811222335,,,05/17/1990,\n" + // US order date
		"G,0811222336,,,,\n" + // fine
		"H,0811222336,,,,\n" + // duplicate of G in file
		"I,0811222337,,,," + strings.Repeat("x", MaxText+1) + "\n" // too long
	p := planCustomers(t, csv, nil)
	r := p.Report
	want := map[string]bool{"required": true, "phone_scientific": true, "invalid_phone": true, "invalid_date": true, "duplicate_in_file": true, "too_long": true}
	got := map[string]bool{}
	for _, c := range issueCodes(r, SevError) {
		got[c] = true
	}
	for c := range want {
		if !got[c] {
			t.Errorf("missing error code %s in %v", c, issueCodes(r, SevError))
		}
	}
	if r.Summary.Error != 8 { // rows 1,2,3,4,6,7,9,10
		t.Errorf("error rows = %d want 8: %+v", r.Summary.Error, r.Summary)
	}
	if r.Summary.Create != 2 { // D (warning only) and G
		t.Errorf("create = %d want 2", r.Summary.Create)
	}
	if !r.HasErrors() {
		t.Error("HasErrors must be true")
	}
	// the duplicate row is the later one, and it names the first
	for _, i := range r.Issues {
		if i.Code == "duplicate_in_file" && (i.Row != 9 || !strings.Contains(i.Message, "baris 8")) {
			t.Errorf("duplicate issue %+v", i)
		}
	}
	if len(p.Creates) != 2 {
		t.Errorf("creates = %d", len(p.Creates))
	}
}

func TestPlanCustomersFileErrorPlansNothing(t *testing.T) {
	p := planCustomers(t, "Nama\nA\n", nil) // missing Telepon column
	if !p.Report.HasErrors() || len(p.Creates) != 0 || len(p.Report.Rows) != 0 {
		t.Errorf("%+v", p.Report)
	}
}

func TestPlanCustomersLookupFailureIsReturned(t *testing.T) {
	tb := Read([]byte("Nama,Telepon\nA,0811111111\n"), CustomerSpec)
	_, err := PlanCustomers(tb, func([]string) (map[string]int, error) { return nil, errors.New("db down") })
	if err == nil {
		t.Fatal("lookup error must surface")
	}
}

func TestPlanCustomersIgnoresExportOnlyColumnsWithWarning(t *testing.T) {
	csv := "Nama,Telepon,Email,Poin,Total Belanja,Jumlah Kunjungan,Tag,Segmen\nA,0811111111,,5,100,2,vip,gold\n"
	p := planCustomers(t, csv, nil)
	n := 0
	for _, f := range p.Report.FileIssues {
		if f.Code == "ignored_column" {
			n++
		}
	}
	if n != 5 || p.Report.Summary.Create != 1 {
		t.Errorf("ignored=%d summary=%+v", n, p.Report.Summary)
	}
}

func TestRedactedReportHasNoPersonalValues(t *testing.T) {
	csv := "Nama,Telepon,Email\nAyu Rahasia,0811999888,ayu@rahasia.example\nBudi,6.28E+11,not-an-email\n"
	p := planCustomers(t, csv, map[string]int{"0811999888": 1})
	live, _ := json.Marshal(p.Report)
	if !strings.Contains(string(live), "0811999888") {
		t.Fatal("the live report must keep the values the user is looking at")
	}
	red := p.Report.Redacted()
	raw, _ := json.Marshal(red)
	for _, secret := range []string{"0811999888", "ayu@rahasia.example", "Ayu Rahasia", "not-an-email", "6.28E+11"} {
		if strings.Contains(string(raw), secret) {
			t.Errorf("redacted report still contains %q: %s", secret, raw)
		}
	}
	if red.Summary != p.Report.Summary || len(red.Issues) != len(p.Report.Issues) || len(red.Rows) != len(p.Report.Rows) {
		t.Error("redaction must keep counts, issues and rows")
	}
	for i, is := range red.Issues {
		if is.Code != p.Report.Issues[i].Code || is.Row != p.Report.Issues[i].Row {
			t.Errorf("issue %d lost code/row", i)
		}
	}
	// the original is untouched
	if p.Report.Issues[0].Value == "" {
		t.Error("Redacted mutated the original")
	}
}

func TestIssuesAreCapped(t *testing.T) {
	sb2 := strings.Builder{}
	sb2.WriteString("Nama,Telepon\n")
	for i := 0; i < MaxIssues+50; i++ {
		sb2.WriteString("," + "0811")
		sb2.WriteString("\n")
	}
	p := planCustomers(t, sb2.String(), nil)
	if len(p.Report.Issues) != MaxIssues {
		t.Fatalf("issues = %d want cap %d", len(p.Report.Issues), MaxIssues)
	}
	if p.Report.Summary.Error != MaxIssues+50 {
		t.Errorf("summary stays exact: %d", p.Report.Summary.Error)
	}
	if len(p.Report.Rows) != MaxReportRows {
		t.Errorf("rows capped at %d, got %d", MaxReportRows, len(p.Report.Rows))
	}
	found := false
	for _, f := range p.Report.FileIssues {
		found = found || f.Code == "too_many_issues"
	}
	if !found {
		t.Error("cap must be announced as a file issue")
	}
}
