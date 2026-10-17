// Package redact scrubs credentials and customer PII from payloads that are
// stored as logs (error_logs, review reports). It is the Go twin of
// packages/sync/src/redact.ts and runs the same vector file
// (packages/sync/src/__fixtures__/redact-vectors.json) in its tests, so the
// client and server redactors cannot drift (A37).
//
// Two tiers: Secrets (credential keys + Bearer/JWT/URL-secret string patterns)
// and Logs (Secrets + PII keys + email/phone patterns + size caps). Functions
// never mutate their input: containers are rebuilt.
package redact

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Tier selects how much is redacted.
type Tier int

const (
	// Secrets removes credentials only (review reports: head office needs the customer).
	Secrets Tier = iota
	// Logs removes credentials and customer PII and caps sizes.
	Logs
)

const (
	// Redacted replaces any removed value.
	Redacted = "[REDACTED]"

	maxDepthLogs    = 8
	maxDepthSecrets = 32
	maxStringLogs   = 2048
	maxTotalLogs    = 32 * 1024
)

var (
	secretKeys = map[string]bool{
		"pin": true, "pinhash": true, "password": true, "token": true, "accesstoken": true,
		"refreshtoken": true, "authorization": true, "cookie": true, "secret": true, "apikey": true,
	}
	piiKeys = map[string]bool{
		"phone": true, "email": true, "customerphone": true, "customeremail": true,
		"customername": true, "address": true, "nik": true,
	}
	contactKeys = map[string]bool{"phone": true, "email": true, "customerphone": true, "customeremail": true}
	idKeys      = map[string]bool{
		"idempotencykey": true, "ordernumber": true, "transferno": true, "sku": true, "barcode": true,
	}

	bearerRE    = regexp.MustCompile(`Bearer[ \t\r\n]+[A-Za-z0-9._~+/=-]+`)
	jwtRE       = regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`)
	urlSecretRE = regexp.MustCompile(`((?:^|[?&,;( \t\r\n])(?:token|access_token|key|sig|password)=)[^& \t\r\n#]*`)
	emailRE     = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	// Leading boundary is captured (RE2 has no lookbehind); the trailing one is
	// checked by hand. '-' and '_' count as word characters so UUID and receipt
	// fragments are never mistaken for phone numbers.
	phoneRE = regexp.MustCompile(`(^|[^0-9A-Za-z_-])((?:\+62|62|0)8[0-9]{7,12})`)
)

func isWordChar(b byte) bool {
	return b == '_' || b == '-' || (b >= '0' && b <= '9') || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

func normKey(k string) string {
	return strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(k))
}

func isIDKey(k string) bool {
	lower := strings.ToLower(k)
	return lower == "id" || strings.HasSuffix(k, "Id") || strings.HasSuffix(lower, "_id") || idKeys[normKey(k)]
}

// String redacts patterns inside one string. skipPhone is set under identifier keys.
func String(s string, t Tier) string { return str(s, t, false) }

func str(s string, t Tier, skipPhone bool) string {
	s = strings.ReplaceAll(s, "\x00", "")
	s = bearerRE.ReplaceAllString(s, "Bearer "+Redacted)
	s = jwtRE.ReplaceAllString(s, Redacted)
	s = urlSecretRE.ReplaceAllString(s, "${1}"+Redacted)
	if t != Logs {
		return s
	}
	s = emailRE.ReplaceAllString(s, Redacted)
	if !skipPhone {
		s = redactPhones(s)
	}
	if utf8.RuneCountInString(s) > maxStringLogs {
		s = string([]rune(s)[:maxStringLogs]) + "...[truncated]"
	}
	return s
}

func redactPhones(s string) string {
	var b strings.Builder
	last := 0
	for _, m := range phoneRE.FindAllStringSubmatchIndex(s, -1) {
		numStart, numEnd := m[4], m[5]
		if numEnd < len(s) && isWordChar(s[numEnd]) {
			continue // the number runs into more word characters: not a phone
		}
		b.WriteString(s[last:numStart]) // text plus the leading boundary char
		b.WriteString(Redacted)
		last = numEnd
	}
	b.WriteString(s[last:])
	return b.String()
}

func walk(v any, depth, maxDepth int, t Tier, skipPhone, isCustomer bool) any {
	switch x := v.(type) {
	case string:
		return str(x, t, skipPhone)
	case map[string]any:
		if depth >= maxDepth {
			return "[MaxDepth]"
		}
		out := make(map[string]any, len(x))
		// A bare "name" is a person's name only next to contact fields or inside a
		// "customer" object; product and outlet names stay readable.
		personName := t == Logs && isCustomer
		if t == Logs && !personName {
			for k := range x {
				if contactKeys[normKey(k)] {
					personName = true
					break
				}
			}
		}
		for k, e := range x {
			clean := strings.ReplaceAll(k, "\x00", "")
			nk := normKey(clean)
			if secretKeys[nk] || (t == Logs && (piiKeys[nk] || (personName && nk == "name"))) {
				out[clean] = Redacted
				continue
			}
			out[clean] = walk(e, depth+1, maxDepth, t, isIDKey(clean), nk == "customer")
		}
		return out
	case []any:
		if depth >= maxDepth {
			return "[MaxDepth]"
		}
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = walk(e, depth+1, maxDepth, t, skipPhone, false)
		}
		return out
	default:
		return v
	}
}

// Value redacts a decoded JSON value (strings, float64/json.Number, bool, nil,
// map[string]any, []any). The input is not modified.
func Value(v any, t Tier) any {
	maxDepth := maxDepthSecrets
	if t == Logs {
		maxDepth = maxDepthLogs
	}
	out := walk(v, 0, maxDepth, t, false, false)
	if t == Logs {
		if n := encodedLen(out); n > maxTotalLogs {
			return map[string]any{"_truncated": true, "bytes": n}
		}
	}
	return out
}

func encodedLen(v any) int {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return 0
	}
	return buf.Len() - 1 // trailing newline
}

// JSON decodes raw JSON, redacts it and re-encodes it. The decode/encode round
// trip also turns lone UTF-16 surrogate escapes into U+FFFD, which jsonb needs.
// Invalid JSON returns an error and no output.
func JSON(raw []byte, t Tier) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(Value(v, t)); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
