package bizday

import (
	"testing"
	"time"
	_ "time/tzdata" // test-only: the production binary is static and never loads zone files
)

func TestValid(t *testing.T) {
	for tz, want := range map[string]bool{
		"Asia/Jakarta": true, "Asia/Makassar": true, "Asia/Jayapura": true,
		"": false, "Europe/London": false, "asia/jakarta": false, "UTC": false,
	} {
		if got := Valid(tz); got != want {
			t.Errorf("Valid(%q)=%v want %v", tz, got, want)
		}
	}
}

func TestZoneMatchesTzdata(t *testing.T) {
	// Indonesia has no DST, so a fixed offset must agree with the real zone all year.
	instants := []time.Time{
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 7, 1, 12, 30, 0, 0, time.UTC),
		time.Date(2026, 10, 19, 16, 59, 59, 0, time.UTC), time.Date(2026, 10, 19, 17, 0, 0, 0, time.UTC),
	}
	for tz := range Allowed {
		real, err := time.LoadLocation(tz)
		if err != nil {
			t.Fatal(err)
		}
		for _, at := range instants {
			_, wantOff := at.In(real).Zone()
			_, gotOff := at.In(Zone(tz)).Zone()
			if wantOff != gotOff {
				t.Errorf("%s at %s: offset %d want %d", tz, at, gotOff, wantOff)
			}
		}
	}
}

func TestZoneFallsBackToDefault(t *testing.T) {
	if _, off := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).In(Zone("")).Zone(); off != 7*3600 {
		t.Errorf("empty zone must be WIB, offset %d", off)
	}
	if _, off := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).In(Zone("Mars/Base")).Zone(); off != 7*3600 {
		t.Errorf("unknown zone must be WIB, offset %d", off)
	}
}

func TestValidDay(t *testing.T) {
	for s, want := range map[string]bool{
		"": true, "2026-10-19": true, "2026-02-29": false, "2026-13-01": false, "19-10-2026": false, "2026-10-19T00:00:00Z": false,
	} {
		if got := ValidDay(s); got != want {
			t.Errorf("ValidDay(%q)=%v want %v", s, got, want)
		}
	}
}
