package rules

import (
	"bytes"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

// Captured from the actual HashPassword function before A34e2, with x/crypto
// v0.46.0 and a fixed synthetic salt. It is not a user credential.
//
//go:embed testdata/argon2id-v0.46.0.json
var legacyPasswordFixture []byte

type passwordFixture struct {
	SourceModule string `json:"source_module"`
	Input        string `json:"synthetic_input"`
	SaltHex      string `json:"salt_hex"`
	Encoded      string `json:"encoded"`
}

func loadPasswordFixture(t *testing.T) passwordFixture {
	t.Helper()
	var fixture passwordFixture
	if err := json.Unmarshal(legacyPasswordFixture, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SourceModule != "golang.org/x/crypto v0.46.0" || fixture.Input == "" || fixture.Encoded == "" {
		t.Fatal("missing pre-upgrade fixture provenance or content")
	}
	return fixture
}

func TestPasswordExistingHashCompatibility(t *testing.T) {
	f := loadPasswordFixture(t)
	for _, tc := range []struct {
		name  string
		input string
		want  bool
	}{
		{"correct password", f.Input, true},
		{"wrong password", f.Input + "-wrong", false},
		{"empty password", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ok, err := VerifyPassword(tc.input, f.Encoded)
			if err != nil || ok != tc.want {
				t.Fatalf("VerifyPassword = (%v, %v), want (%v, nil)", ok, err, tc.want)
			}
		})
	}
}

func TestPasswordLegacyEncoding(t *testing.T) {
	f := loadPasswordFixture(t)
	salt, err := hex.DecodeString(f.SaltHex)
	if err != nil || len(salt) != 16 {
		t.Fatal("invalid synthetic fixture salt")
	}
	if argonTime != 1 || argonMemory != 65536 || argonThreads != 4 || argonKeyLen != 32 || argonSaltLen != 16 {
		t.Fatal("password parameters changed from the pre-upgrade contract")
	}
	// This test must remain serial: crypto/rand.Reader is process-global.
	saved := rand.Reader
	rand.Reader = bytes.NewReader(salt)
	t.Cleanup(func() { rand.Reader = saved })
	encoded, err := HashPassword(f.Input)
	if err != nil {
		t.Fatal(err)
	}
	if encoded != f.Encoded {
		t.Fatal("fixed-input encoded hash differs from the pre-upgrade fixture")
	}
}

func TestPasswordNewHashes(t *testing.T) {
	f := loadPasswordFixture(t)
	var previous string
	for i := 0; i < 2; i++ {
		encoded, err := HashPassword(f.Input)
		if err != nil {
			t.Fatal(err)
		}
		parts := strings.Split(encoded, "$")
		if len(parts) != 6 || strings.Join(parts[:4], "$") != "$argon2id$v=19$m=65536,t=1,p=4" {
			t.Fatal("new hash changed the stored algorithm/version/parameter format")
		}
		salt, saltErr := base64.RawStdEncoding.DecodeString(parts[4])
		key, keyErr := base64.RawStdEncoding.DecodeString(parts[5])
		if saltErr != nil || keyErr != nil || len(salt) != 16 || len(key) != 32 {
			t.Fatal("new hash changed salt/key encoding or length")
		}
		if encoded == previous || encoded == f.Encoded {
			t.Fatal("new hash reused a salt")
		}
		if ok, err := VerifyPassword(f.Input, encoded); !ok || err != nil {
			t.Fatalf("new hash did not verify: %v, %v", ok, err)
		}
		if ok, err := VerifyPassword(f.Input+"-wrong", encoded); ok || err != nil {
			t.Fatalf("new hash accepted wrong password or errored: %v, %v", ok, err)
		}
		previous = encoded
	}
}

func TestPasswordTamperedHash(t *testing.T) {
	f := loadPasswordFixture(t)
	parts := strings.Split(f.Encoded, "$")
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) != 32 {
		t.Fatal("invalid fixture digest")
	}
	key[0] ^= 1
	parts[5] = base64.RawStdEncoding.EncodeToString(key)
	if ok, err := VerifyPassword(f.Input, strings.Join(parts, "$")); ok || err != nil {
		t.Fatalf("mutated stored digest result = (%v, %v), want (false, nil)", ok, err)
	}
}

func TestPasswordMalformedHashCompatibility(t *testing.T) {
	f := loadPasswordFixture(t)
	parts := strings.Split(f.Encoded, "$")
	cases := map[string]string{
		"empty":              "",
		"wrong parts":        "not-a-hash",
		"wrong algorithm":    strings.Replace(f.Encoded, "argon2id", "argon2i", 1),
		"invalid version":    strings.Replace(f.Encoded, "v=19", "v=no", 1),
		"invalid parameters": strings.Replace(f.Encoded, "m=65536", "m=no", 1),
		"invalid salt":       strings.Replace(f.Encoded, parts[4], "!", 1),
		"invalid digest":     strings.Join(parts[:5], "$") + "$!",
	}
	for name, encoded := range cases {
		t.Run(name, func(t *testing.T) {
			if ok, err := VerifyPassword(f.Input, encoded); ok || err != errBadHash {
				t.Fatalf("malformed hash result = (%v, %v), want (false, errBadHash)", ok, err)
			}
		})
	}
}

func TestPasswordLegacyParserCharacterization(t *testing.T) {
	f := loadPasswordFixture(t)
	// These existing parser limitations are characterized only to separate a
	// dependency update from input hardening. They are not a security policy.
	t.Run("numeric version remains unvalidated", func(t *testing.T) {
		if ok, err := VerifyPassword(f.Input, strings.Replace(f.Encoded, "v=19", "v=18", 1)); !ok || err != nil {
			t.Fatalf("legacy numeric-version behavior changed: %v, %v", ok, err)
		}
	})
	for _, tc := range []struct{ name, from, to, panicText string }{
		{"zero rounds", "t=1", "t=0", "argon2: number of rounds too small"},
		{"zero threads", "p=4", "p=0", "argon2: parallelism degree too low"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if got := recover(); got != tc.panicText {
					t.Fatalf("legacy panic = %v, want %q", got, tc.panicText)
				}
			}()
			_, _ = VerifyPassword(f.Input, strings.Replace(f.Encoded, tc.from, tc.to, 1))
		})
	}
}
