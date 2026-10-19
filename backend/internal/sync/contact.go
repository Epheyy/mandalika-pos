package sync

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"time"

	"github.com/google/uuid"
)

// ContactToken is the server-signed proof of a tablet's last successful online
// contact (A05). At is server time, kept verbatim because the signature covers the
// exact string; Sig binds it to one device id. A client cannot mint a later contact.
type ContactToken struct {
	At  string `json:"at"`
	Sig string `json:"sig"`
}

const contactDomain = "mandalika/offline-contact/v1"

// DeriveContactKey derives the contact signing key from the JWT access secret
// (no new env var). Rotating the access secret makes old tokens unverifiable; the
// cap then falls back to the elapsed-only rule, which is safe. Empty secret = no key.
func DeriveContactKey(accessSecret []byte) []byte {
	if len(accessSecret) == 0 {
		return nil
	}
	m := hmac.New(sha256.New, accessSecret)
	m.Write([]byte(contactDomain))
	return m.Sum(nil)
}

func contactMAC(key []byte, deviceID, at string) string {
	m := hmac.New(sha256.New, key)
	m.Write([]byte("v1|" + deviceID + "|" + at))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// SignContact signs a contact at server time at for deviceID.
func SignContact(key []byte, deviceID string, at time.Time) ContactToken {
	s := at.UTC().Format(time.RFC3339Nano)
	return ContactToken{At: s, Sig: contactMAC(key, deviceID, s)}
}

// VerifyContact returns the signed contact time when the signature is valid for
// deviceID and the time is not in the future beyond ClockTolerance.
func VerifyContact(key []byte, deviceID string, tok ContactToken, now time.Time) (time.Time, bool) {
	if len(key) == 0 || tok.At == "" || tok.Sig == "" {
		return time.Time{}, false
	}
	if !hmac.Equal([]byte(contactMAC(key, deviceID, tok.At)), []byte(tok.Sig)) {
		return time.Time{}, false
	}
	at, err := time.Parse(time.RFC3339Nano, tok.At)
	if err != nil || at.After(now.Add(ClockTolerance)) {
		return time.Time{}, false
	}
	return at, true
}

// ContactFor issues a contact for a device id that is a uuid, or nil (no key, or an
// invalid id: the caller simply omits the field).
func (e *Engine) ContactFor(deviceID string) *ContactToken {
	if len(e.ContactKey) == 0 {
		return nil
	}
	if _, err := uuid.Parse(deviceID); err != nil {
		return nil
	}
	tok := SignContact(e.ContactKey, deviceID, e.now())
	return &tok
}
