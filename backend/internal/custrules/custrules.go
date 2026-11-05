// Package custrules holds the customer-field rules shared by every write path: the
// backoffice customer form and the POS "+ Baru" customer sync. Its TypeScript twin is
// packages/types/src/customerRules.ts; both read packages/types/src/__fixtures__.
package custrules

import (
	"errors"
	"regexp"
	"strings"

	"github.com/mandalika/pos-backend/internal/phone"
)

var (
	// ErrPhoneRequired and ErrPhoneInvalid are shown to the operator as is.
	ErrPhoneRequired = errors.New("Nomor telepon wajib diisi")
	ErrPhoneInvalid  = errors.New("Nomor telepon tidak valid")
	ErrEmailInvalid  = errors.New("Format email tidak valid")
)

// maxEmailLen is the RFC 5321 path limit.
const maxEmailLen = 254

// CheckPhone returns nil when raw is a usable phone (Indonesian or international,
// see phone.Normalize), else ErrPhoneRequired / ErrPhoneInvalid.
func CheckPhone(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return ErrPhoneRequired
	}
	if phone.Normalize(raw) == "" {
		return ErrPhoneInvalid
	}
	return nil
}

// emailShape is the same pattern in the TypeScript twin: a deliberately simple shape check.
var emailShape = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// CheckEmail accepts an empty value (email is optional) or text shaped like a@b.c: one
// '@', non-empty parts, a dot in the domain, no whitespace.
func CheckEmail(raw string) error {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil
	}
	if len(s) > maxEmailLen || !emailShape.MatchString(s) {
		return ErrEmailInvalid
	}
	return nil
}
