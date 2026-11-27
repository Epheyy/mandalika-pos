package receiptlink

import (
	"crypto/rand"
	"crypto/sha256"
)

// NewSalt returns the per-link 16-byte salt of the same-network flag.
func NewSalt() ([]byte, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

// NetHash is SHA-256(salt || client IP bucket). It is stored when the link is made and compared
// when the rating arrives; only the resulting boolean is kept, never an address.
func NetHash(salt []byte, bucket string) []byte {
	h := sha256.New()
	h.Write(salt)
	h.Write([]byte(bucket))
	return h.Sum(nil)
}
