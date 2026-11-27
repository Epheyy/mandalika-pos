// Package receiptlink holds the customer-facing receipt/rating link: the token, the WhatsApp
// message template (Go twin of packages/types/src/waReceipt.ts), the same-network flag hash and
// the server-rendered public page. A leaf: stdlib plus internal/phone only.
package receiptlink

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
)

// TokenLen is the length of a token string: 16 random bytes in unpadded base64url.
const TokenLen = 22

var tokenShape = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

// NewToken returns a fresh 128-bit random token and its SHA-256. Only the hash is ever stored.
func NewToken() (token string, hash []byte, err error) {
	b := make([]byte, 16)
	if _, err = rand.Read(b); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	h := sha256.Sum256([]byte(token))
	return token, h[:], nil
}

// HashToken returns the SHA-256 of a token, or ok=false when the string cannot be a token
// (wrong length or alphabet), so a malformed path never reaches the database.
func HashToken(s string) (hash []byte, ok bool) {
	if !tokenShape.MatchString(s) {
		return nil, false
	}
	h := sha256.Sum256([]byte(s))
	return h[:], true
}
