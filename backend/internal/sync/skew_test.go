package sync

import (
	"testing"
	"time"
)

func tp(t time.Time) *time.Time { return &t }

func TestBoundSaleTime(t *testing.T) {
	A := capA
	L := A.Add(-10 * time.Hour)
	cases := []struct {
		name     string
		ev       offlineEvidence
		c        *time.Time
		wantEval *time.Time
		skew     bool
	}{
		{"no client time", offlineEvidence{LOK: true, L: L}, nil, nil, false},
		{"verified, C inside window", offlineEvidence{LOK: true, L: L, HasE: true, E: time.Hour}, tp(L.Add(30 * time.Minute)), nil, false},
		{"verified, C at A+tol edge", offlineEvidence{LOK: true, L: L}, tp(A.Add(ClockTolerance)), nil, false},
		{"verified, C far future, E known: L+E", offlineEvidence{LOK: true, L: L, HasE: true, E: 2 * time.Hour}, tp(A.Add(48 * time.Hour)), tp(L.Add(2 * time.Hour)), true},
		{"verified, C before L, E known: L+E", offlineEvidence{LOK: true, L: L, HasE: true, E: 2 * time.Hour}, tp(L.Add(-24 * time.Hour)), tp(L.Add(2 * time.Hour)), true},
		{"verified, E unknown, C future: clamp to A", offlineEvidence{LOK: true, L: L}, tp(A.Add(48 * time.Hour)), tp(A), true},
		{"verified, E unknown, C before L: clamp to L", offlineEvidence{LOK: true, L: L}, tp(L.Add(-48 * time.Hour)), tp(L), true},
		{"verified, L+E past A: clamp to A", offlineEvidence{LOK: true, L: L, HasE: true, E: 30 * time.Hour}, tp(A.Add(48 * time.Hour)), tp(A), true},
		{"unverified, C future: A", offlineEvidence{}, tp(A.Add(time.Hour)), tp(A), true},
		{"unverified, C in the past: untouched (late sync)", offlineEvidence{}, tp(A.Add(-72 * time.Hour)), nil, false},
		{"unverified, C within tolerance of A", offlineEvidence{}, tp(A.Add(ClockTolerance)), nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, skew := boundSaleTime(tc.ev, tc.c, A)
			if skew != tc.skew || (got == nil) != (tc.wantEval == nil) || (got != nil && !got.Equal(*tc.wantEval)) {
				t.Fatalf("got %v skew=%v, want %v skew=%v", got, skew, tc.wantEval, tc.skew)
			}
		})
	}
}
