// Package redact scrubs credentials and customer PII from payloads that are
// stored as logs (error_logs, review reports). It is the Go twin of
// packages/sync/src/redact.ts and runs the same vector file
// (packages/sync/src/__fixtures__/redact-vectors.json) in its tests, so the
// client and server redactors cannot drift (A37).
//
// Two tiers: Secrets (credential keys + Bearer/Basic/JWT/URL/JSON-secret string
// patterns) and Logs (Secrets + PII keys + email/phone patterns + size caps).
// Functions never mutate their input: containers are rebuilt.
//
// Size rules are identical in both twins: strings are cut by code point, and
// the Logs tier measures output with a deterministic estimate (UTF-8 bytes of
// keys and strings plus fixed per-node overhead), not an encoder, so the
// truncation decision cannot differ between languages.
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
	maxStringLogs   = 2048 // code points
	maxStackLogs    = 4096 // code points, for fields keyed "stack"
	preCutFactor    = 4    // strings are cut to factor*cap before any regex runs
	maxTotalLogs    = 32 * 1024
	maxNodesLogs    = 5000
	maxNodesSecrets = 100000
	nodeOverhead    = 6 // estimated JSON bytes per scalar/container
	keyOverhead     = 4
	truncatedSuffix = "...[truncated]"
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

	keyNormalizer = strings.NewReplacer("_", "", "-", "")

	bearerRE = regexp.MustCompile(`(?i)Bearer[ \t\r\n]+[A-Za-z0-9._~+/=-]+`)
	basicRE  = regexp.MustCompile(`(?i)(Authorization:[ \t]*)Basic[ \t]+[A-Za-z0-9+/]+={0,2}`)
	// Segments are unbounded: the Logs-tier pre-cut (4x the cap) bounds the input, and RE2 is linear.
	jwtRE = regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*`)
	// JSON inside a string: plain quotes or backslash-escaped quotes (double encoding), and a value
	// that is a whole string literal (escaped quotes inside it included), a number or a bare word.
	jsonSecretRE = regexp.MustCompile(`(?i)\\?"(pin|pinhash|password|token|accesstoken|refreshtoken|authorization|cookie|secret|apikey|access_token|refresh_token|api_key)\\?"[ \t]*:[ \t]*(?:\\"(?:[^"\\]|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|[^,}\] \t\r\n"\\]+)`)
	urlSecretRE  = regexp.MustCompile(`(?i)((?:^|[?&,;( \t\r\n])(?:token|access_token|key|sig|password|pin|api_key|apikey)=)[^& \t\r\n#]*`)
	emailRE      = regexp.MustCompile(`[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}`)
)

func isWordChar(b byte) bool {
	return b == '_' || b == '-' || (b >= '0' && b <= '9') || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z')
}

func normKey(k string) string {
	return keyNormalizer.Replace(strings.ToLower(k))
}

func isIDKey(k string) bool {
	lower := strings.ToLower(k)
	return lower == "id" || strings.HasSuffix(k, "Id") || strings.HasSuffix(lower, "_id") || idKeys[normKey(k)]
}

// cutRunes returns s limited to n code points.
func cutRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}

func runeCountExceeds(s string, n int) bool {
	if len(s) <= n {
		return false
	}
	return utf8.RuneCountInString(s) > n
}

// String redacts patterns inside one string (Logs tier uses the default string cap).
func String(s string, t Tier) string { return str(s, t, false, maxStringLogs) }

// Stack redacts a stack trace: Logs tier with the larger stack cap.
func Stack(s string) string { return str(s, Logs, false, maxStackLogs) }

func str(s string, t Tier, skipPhone bool, capCP int) string {
	s = strings.ReplaceAll(s, "\x00", "")
	if t == Logs {
		s = cutRunes(s, capCP*preCutFactor)
	}
	s = bearerRE.ReplaceAllString(s, "Bearer "+Redacted)
	s = basicRE.ReplaceAllString(s, "${1}Basic "+Redacted)
	s = jwtRE.ReplaceAllString(s, Redacted)
	s = jsonSecretRE.ReplaceAllString(s, `"${1}":"`+Redacted+`"`)
	s = urlSecretRE.ReplaceAllString(s, "${1}"+Redacted)
	if t != Logs {
		return s
	}
	s = emailRE.ReplaceAllString(s, Redacted)
	if !skipPhone {
		s = redactPhones(s)
	}
	if runeCountExceeds(s, capCP) {
		s = cutRunes(s, capCP) + truncatedSuffix
	}
	return s
}

func isDigit(b byte) bool { return b >= '0' && b <= '9' }

func isPhoneSep(b byte) bool { return b == ' ' || b == '.' || b == '-' }

// redactPhones replaces Indonesian phone numbers: a prefix (0, 62 or +62) directly followed
// by 8 (a single separator may sit between 62/+62 and the 8), then further digit runs of at
// least 4 digits joined by ONE separator (space, dot, hyphen, or ")" with an optional space).
// Total digits must be prefix+1+7 .. prefix+1+12. Whole runs only: when the next run would
// exceed the maximum the number ends there, but it must then be followed by a non-word
// character ('-' counts as a word character, so a long hyphenated code is never cut).
// The TS twin implements the same scanner.
func redactPhones(s string) string {
	var b strings.Builder
	last, i, n := 0, 0, len(s)
	for i < n {
		if i > 0 && isWordChar(s[i-1]) {
			i++
			continue
		}
		pdig, q := 0, i
		switch {
		case strings.HasPrefix(s[i:], "+62"):
			pdig, q = 2, i+3
		case strings.HasPrefix(s[i:], "62"):
			pdig, q = 2, i+2
		case s[i] == '0':
			pdig, q = 1, i+1
		default:
			i++
			continue
		}
		if pdig == 2 && q < n && isPhoneSep(s[q]) {
			q++
		}
		if q >= n || s[q] != '8' {
			i++
			continue
		}
		maxDigits, minDigits := pdig+1+12, pdig+1+7
		r := q
		for r < n && isDigit(s[r]) {
			r++
		}
		digits, end, paren := pdig+(r-q), r, false
		if digits > maxDigits {
			i = end
			continue
		}
		for end < n {
			sepEnd, isParen := end, false
			switch {
			case isPhoneSep(s[end]):
				sepEnd = end + 1
			case s[end] == ')':
				sepEnd, isParen = end+1, true
				if sepEnd < n && s[sepEnd] == ' ' {
					sepEnd++
				}
			default:
				sepEnd = -1
			}
			if sepEnd < 0 {
				break
			}
			v := sepEnd
			for v < n && isDigit(s[v]) {
				v++
			}
			if v-sepEnd < 4 || digits+(v-sepEnd) > maxDigits {
				break
			}
			digits += v - sepEnd
			end = v
			paren = paren || isParen
		}
		if digits < minDigits || (end < n && isWordChar(s[end])) {
			i = end
			continue
		}
		begin := i
		if paren && i > 0 && s[i-1] == '(' {
			begin = i - 1
		}
		b.WriteString(s[last:begin])
		b.WriteString(Redacted)
		last, i = end, end
	}
	b.WriteString(s[last:])
	return b.String()
}

// walker carries the per-call budget: a node cap and (Logs) the running size estimate.
type walker struct {
	t        Tier
	maxDepth int
	maxNodes int
	maxBytes int // 0 = unlimited
	nodes    int
	bytes    int
	over     bool
}

func (w *walker) account(n int) {
	w.bytes += n
	if w.maxBytes > 0 && w.bytes > w.maxBytes {
		w.over = true
	}
}

func (w *walker) visit() bool {
	w.nodes++
	if w.nodes > w.maxNodes {
		w.over = true
	}
	return !w.over
}

func (w *walker) walk(v any, depth int, skipPhone, isCustomer bool, capCP int) any {
	if !w.visit() {
		return nil
	}
	switch x := v.(type) {
	case string:
		out := str(x, w.t, skipPhone, capCP)
		w.account(len(out) + 2)
		return out
	case map[string]any:
		if depth >= w.maxDepth {
			return "[MaxDepth]"
		}
		w.account(nodeOverhead)
		out := make(map[string]any, len(x))
		// A bare "name" is a person's name only next to contact fields or inside a
		// "customer" object; product and outlet names stay readable.
		personName := w.t == Logs && isCustomer
		if w.t == Logs && !personName {
			for k := range x {
				if contactKeys[normKey(k)] {
					personName = true
					break
				}
			}
		}
		for k, e := range x {
			if w.over {
				break
			}
			clean := strings.ReplaceAll(k, "\x00", "")
			nk := normKey(clean)
			w.account(len(clean) + keyOverhead)
			if secretKeys[nk] || (w.t == Logs && (piiKeys[nk] || (personName && nk == "name"))) {
				out[clean] = Redacted
				w.account(len(Redacted) + 2)
				continue
			}
			cp := maxStringLogs
			if nk == "stack" {
				cp = maxStackLogs
			}
			out[clean] = w.walk(e, depth+1, isIDKey(clean), nk == "customer", cp)
		}
		return out
	case []any:
		if depth >= w.maxDepth {
			return "[MaxDepth]"
		}
		w.account(nodeOverhead)
		out := make([]any, len(x))
		for i, e := range x {
			if w.over {
				break
			}
			out[i] = w.walk(e, depth+1, skipPhone, false, capCP)
		}
		return out
	default:
		w.account(nodeOverhead)
		return v
	}
}

// Value redacts a decoded JSON value (strings, float64/json.Number, bool, nil,
// map[string]any, []any). The input is not modified. A Logs-tier result that
// exceeds the node or size budget is replaced by {"_truncated":true,"bytes":n}.
func Value(v any, t Tier) any {
	w := &walker{t: t, maxDepth: maxDepthSecrets, maxNodes: maxNodesSecrets}
	if t == Logs {
		w.maxDepth, w.maxNodes, w.maxBytes = maxDepthLogs, maxNodesLogs, maxTotalLogs
	}
	out := w.walk(v, 0, false, false, maxStringLogs)
	if w.over {
		return map[string]any{"_truncated": true, "bytes": w.bytes}
	}
	return out
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
