package csvimport

import "testing"

func TestParseRupiah(t *testing.T) {
	cases := []struct {
		in       string
		fraction bool
		want     float64
		wantErr  bool
	}{
		{"150000", false, 150000, false},
		{"150.000", false, 150000, false},
		{"150,000", false, 150000, false},
		{"Rp 150.000", false, 150000, false},
		{"Rp150.000", false, 150000, false},
		{"rp. 1.250.000", false, 1250000, false},
		{"1.250.000", false, 1250000, false},
		{"0", false, 0, false},
		{"", false, 0, true},
		{"   ", false, 0, true},
		{"-5000", false, 0, true},
		{"1.5", false, 0, true},       // not a 3-digit group, fractions not allowed
		{"150.00", false, 0, true},    // ditto
		{"1.250,000", false, 0, true}, // mixed separators
		{"1,250.000", false, 0, true},
		{"1.25.000", false, 0, true}, // group of 2 digits
		{"1..000", false, 0, true},
		{".000", false, 0, true},
		{"abc", false, 0, true},
		{"12abc", false, 0, true},
		{"1e5", false, 0, true},
		{"1000000000000", false, 0, true}, // over numeric(14,2) headroom
		{"0,125", false, 0, true},         // leading 0 + 3 digits: grouping or decimal? ambiguous
		{"0.500", false, 0, true},
		{"000.500", false, 0, true},
		{"00.000", false, 0, true},
		{"0,125", true, 0, true},
		{"0.000", false, 0, true},
		{"0,5", true, 0.5, false},
		{"12,5", true, 12.5, false},
		{"12.50", true, 12.5, false},
		{"0,5", true, 0.5, false},
		{"1.234", true, 1234, false}, // 3 digits = grouping, never a guess at a fraction
		{"15000", true, 15000, false},
		{"12,555", true, 12555, false},
		{"12,5555", true, 0, true},
		{"1.250.000,5", true, 0, true}, // mixed
	}
	for _, c := range cases {
		got, err := ParseRupiah(c.in, c.fraction)
		if (err != nil) != c.wantErr {
			t.Errorf("ParseRupiah(%q,%v) err=%v wantErr=%v", c.in, c.fraction, err, c.wantErr)
			continue
		}
		if err == nil && got != c.want {
			t.Errorf("ParseRupiah(%q,%v)=%v want %v", c.in, c.fraction, got, c.want)
		}
	}
}

func TestParseDate(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"1990-05-17", "1990-05-17", false},
		{"17/05/1990", "1990-05-17", false},
		{"17-05-1990", "1990-05-17", false},
		{"7/5/1990", "1990-05-07", false},
		{"29/02/2024", "2024-02-29", false},
		{"29/02/2023", "", true}, // not a real calendar day
		{"31-04-2020", "", true},
		{"2020-13-01", "", true},
		{"05/17/1990", "", true}, // US order is not guessed
		{"17.05.1990", "", true},
		{"1990/05/17", "", true},
		{"17 Mei 1990", "", true},
		{"", "", true},
		{"1800-01-01", "", true},
	}
	for _, c := range cases {
		got, err := ParseDate(c.in)
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("ParseDate(%q)=%q,%v want %q wantErr=%v", c.in, got, err, c.want, c.wantErr)
		}
	}
}

func TestParseBool(t *testing.T) {
	yes := []string{"Ya", "ya", "YA", "Y", "y", "true", "TRUE", "1", " Ya "}
	no := []string{"Tidak", "tidak", "T", "t", "false", "FALSE", "0"}
	bad := []string{"", "yes", "no", "2", "ya ya", "N"}
	for _, s := range yes {
		if v, err := ParseBool(s); err != nil || !v {
			t.Errorf("ParseBool(%q)=%v,%v want true", s, v, err)
		}
	}
	for _, s := range no {
		if v, err := ParseBool(s); err != nil || v {
			t.Errorf("ParseBool(%q)=%v,%v want false", s, v, err)
		}
	}
	for _, s := range bad {
		if _, err := ParseBool(s); err == nil {
			t.Errorf("ParseBool(%q) should fail", s)
		}
	}
}

func TestCleanPhoneAndProblems(t *testing.T) {
	if got := CleanPhone(" 0812-3456 (789).0 "); got != "081234567890" {
		t.Errorf("CleanPhone = %q", got)
	}
	if got := CleanPhone("+62 812 3456 789"); got != "+628123456789" {
		t.Errorf("CleanPhone keeps leading +, got %q", got)
	}
	for _, s := range []string{"6.28E+11", "6.28e11", "8.12345E+10"} {
		if !LooksScientific(s) {
			t.Errorf("LooksScientific(%q) should be true", s)
		}
	}
	for _, s := range []string{"0812345678", "+62812345", "081234E", "12e"} {
		if LooksScientific(s) {
			t.Errorf("LooksScientific(%q) should be false", s)
		}
	}
	if err := ValidPhone("081234567890"); err != nil {
		t.Errorf("valid phone rejected: %v", err)
	}
	for _, s := range []string{"", "12345", "abc12345", "08123+456789", "081234567890123456789"} {
		if err := ValidPhone(s); err == nil {
			t.Errorf("ValidPhone(%q) should fail", s)
		}
	}
	if !MissingLeadingZero("812345678") || MissingLeadingZero("0812345678") || MissingLeadingZero("+62812345678") {
		t.Error("MissingLeadingZero wrong")
	}
}

func TestLengthCapCountsRunes(t *testing.T) {
	if CheckLen("香香香", 3) != nil {
		t.Error("3 runes within cap 3")
	}
	if CheckLen("香香香香", 3) == nil {
		t.Error("4 runes over cap 3")
	}
}

func TestValidEmail(t *testing.T) {
	for _, s := range []string{"a@b.co", "ni.luh@mandalika.co.id"} {
		if !ValidEmail(s) {
			t.Errorf("ValidEmail(%q)", s)
		}
	}
	for _, s := range []string{"a@b", "a b@c.d", "@c.d", "plain"} {
		if ValidEmail(s) {
			t.Errorf("!ValidEmail(%q)", s)
		}
	}
}
