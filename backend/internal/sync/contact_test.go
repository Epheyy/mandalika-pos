package sync

import (
	"strings"
	"testing"
	"time"
)

func TestContactSignVerify(t *testing.T) {
	key := DeriveContactKey([]byte(strings.Repeat("s", 48)))
	now := time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)
	tok := SignContact(key, "dev1", now)
	if tok.At == "" || tok.Sig == "" {
		t.Fatalf("empty token %+v", tok)
	}

	other := DeriveContactKey([]byte(strings.Repeat("x", 48)))
	tampered := ContactToken{At: now.Add(time.Hour).Format(time.RFC3339Nano), Sig: tok.Sig}
	future := SignContact(key, "dev1", now.Add(time.Hour))

	cases := []struct {
		name   string
		key    []byte
		device string
		tok    ContactToken
		ok     bool
	}{
		{"valid", key, "dev1", tok, true},
		{"wrong device", key, "dev2", tok, false},
		{"tampered at", key, "dev1", tampered, false},
		{"wrong key", other, "dev1", tok, false},
		{"empty key", nil, "dev1", tok, false},
		{"future at", key, "dev1", future, false},
		{"garbage at", key, "dev1", ContactToken{At: "nope", Sig: tok.Sig}, false},
		{"empty sig", key, "dev1", ContactToken{At: tok.At}, false},
	}
	for _, tc := range cases {
		at, ok := VerifyContact(tc.key, tc.device, tc.tok, now)
		if ok != tc.ok {
			t.Errorf("%s: ok=%v want %v", tc.name, ok, tc.ok)
		}
		if ok && !at.Equal(now) {
			t.Errorf("%s: at=%v want %v", tc.name, at, now)
		}
	}
}

func TestContactFutureWithinToleranceVerifies(t *testing.T) {
	key := DeriveContactKey([]byte(strings.Repeat("s", 48)))
	now := time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)
	tok := SignContact(key, "dev1", now.Add(ClockTolerance-time.Second))
	if _, ok := VerifyContact(key, "dev1", tok, now); !ok {
		t.Fatal("a contact within clock tolerance of now must verify")
	}
}

func TestDeriveContactKeyIsDomainSeparated(t *testing.T) {
	secret := []byte(strings.Repeat("s", 48))
	k := DeriveContactKey(secret)
	if len(k) != 32 || string(k) == string(secret) {
		t.Fatalf("derived key must be a 32-byte digest distinct from the secret, got %d bytes", len(k))
	}
	if string(k) != string(DeriveContactKey(secret)) {
		t.Fatal("derivation must be deterministic")
	}
	if DeriveContactKey(nil) != nil {
		t.Fatal("empty secret must give no key")
	}
}

func TestEngineContactFor(t *testing.T) {
	now := time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)
	key := DeriveContactKey([]byte(strings.Repeat("s", 48)))
	e := &Engine{ContactKey: key, Now: func() time.Time { return now }}
	const dev = "11111111-2222-4333-8444-555555555555"

	tok := e.ContactFor(dev)
	if tok == nil {
		t.Fatal("a uuid device id must get a contact")
	}
	if at, ok := VerifyContact(key, dev, *tok, now); !ok || !at.Equal(now) {
		t.Fatalf("returned contact does not verify: %+v", tok)
	}
	for _, bad := range []string{"", "not-a-uuid", "dev:1"} {
		if e.ContactFor(bad) != nil {
			t.Errorf("device id %q must not get a contact", bad)
		}
	}
	if (&Engine{}).ContactFor(dev) != nil {
		t.Error("an engine without a key must not issue contacts")
	}
}
