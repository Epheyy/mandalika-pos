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
		"passwd": true, "clientsecret": true,
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

	// ASCII whitespace classes and ASCII-only case folding: ci() spells out [bB] classes instead
	// of (?i), whose Unicode folding (Kelvin sign, long s) differs from the TS twin.
	bearerRE = regexp.MustCompile(ci("Bearer") + `[ \t\r\n]+[A-Za-z0-9._~+/=-]+`)
	basicRE  = regexp.MustCompile(`(` + ci("Authorization:") + `[ \t]*)` + ci("Basic") + `[ \t]+[A-Za-z0-9+/]+={0,2}`)
	// Key + colon of a secret entry inside a string that holds JSON, escaped up to three levels
	// (up to 7 backslashes before a quote).
	jsonKeyRE = regexp.MustCompile(`(\\{0,7})"(` + strings.Join([]string{
		`[A-Za-z0-9_-]{0,40}` + ci("pin") + `[_-]?` + ci("hash") + `[A-Za-z0-9_-]{0,40}`,
		ci("pin"), ci("passwd"), ci("password"), ci("token"),
		ci("access") + `[_-]?` + ci("token"), ci("refresh") + `[_-]?` + ci("token"), ci("authorization"), ci("cookie"), ci("secret"),
		ci("client") + `[_-]?` + ci("secret"), ci("api") + `[_-]?` + ci("key"), ci("apikey"),
	}, "|") + `)(\\{0,7})"[ \t\r\n]*:[ \t\r\n]*`)
	urlSecretRE = regexp.MustCompile(`((?:^|[?&,;( \t\r\n])(?:` + strings.Join([]string{
		ci("token"), ci("access_token"), ci("key"), ci("sig"), ci("password"), ci("pin"), ci("api_key"), ci("apikey"),
	}, "|") + `)=)[^& \t\r\n#]*`)
	emailRE = regexp.MustCompile(`[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}`)
)

// ci spells each ASCII letter as a [xX] class (ASCII-only case folding; see bearerRE).
func ci(lit string) string {
	var b strings.Builder
	for _, r := range lit {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			lo, up := r|0x20, r&^0x20
			b.WriteString("[" + string(lo) + string(up) + "]")
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// asciiLower lower-cases ASCII letters only (unicode.ToLower folds non-ASCII differently from JS).
func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// isSecretKey: exact credential names plus anything containing pinhash (receivePinHash, pin_hash...).
func isSecretKey(nk string) bool { return secretKeys[nk] || strings.Contains(nk, "pinhash") }

func normKey(k string) string {
	return keyNormalizer.Replace(asciiLower(k))
}

func isIDKey(k string) bool {
	lower := asciiLower(k)
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
	s = redactJWTs(s)
	s = redactJSONSecrets(s)
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

func isDigit(r rune) bool { return r >= '0' && r <= '9' }

func isB64(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9') || b == '_' || b == '-'
}

// Separators a phone number may be written with: space-like, dash-like, '.', '/', parens, '_'.
func isSpaceLike(r rune) bool {
	switch r {
	case ' ', '\t', ' ', ' ', ' ':
		return true
	}
	return false
}

func isDashLike(r rune) bool {
	switch r {
	case '-', '–', '—', '‑', '−':
		return true
	}
	return false
}

func isPhoneSep(r rune) bool {
	switch r {
	case '.', '/', '(', ')', '_':
		return true
	}
	return isSpaceLike(r) || isDashLike(r)
}

// sepLen is the length of the separator unit at j: " - " (space, dash, space) is ONE unit;
// 0 if there is none.
func sepLen(s []rune, j int) int {
	if j >= len(s) {
		return 0
	}
	if isSpaceLike(s[j]) && j+2 < len(s) && isDashLike(s[j+1]) && isSpaceLike(s[j+2]) {
		return 3
	}
	if isPhoneSep(s[j]) {
		return 1
	}
	return 0
}

const (
	phoneLookahead      = 40 // characters examined per candidate: keeps the scan linear
	phoneChainLookahead = 80
	phoneMinNational    = 9
	phoneMaxNational    = 12
	codeChainDigits     = 20
)

// phoneSpanAt returns the span [begin, end) (rune indexes) of an Indonesian phone number
// starting at the token boundary i, or ok=false. FAIL CLOSED: a prefix (0 directly before the
// 8; or 62, +62 or 0062 with up to three separator units before the 8 and an optional trunk 0
// or (0) in between) then digits and separators (at most two separator units in a row, no
// minimum group size) until the national digits (from the 8) reach 12; the LONGEST prefix
// ending on a digit with 9..12 national digits is taken. Exception: a '-'/'.' joined chain of
// 20+ digits whose candidate would end inside it is a barcode-like code and stays. The TS
// twin implements the same scanner.
func phoneSpanAt(s []rune, i int) (begin, end int, ok bool) {
	n := len(s)
	at := func(k int) rune {
		if k < n {
			return s[k]
		}
		return 0
	}
	begin = i
	q := i
	closeSeen := false
	pfx := 0
	switch {
	case at(i) == '0' && at(i+1) == '0' && at(i+2) == '6' && at(i+3) == '2':
		pfx = 4
	case at(i) == '6' && at(i+1) == '2':
		pfx = 2
	}
	if pfx > 0 {
		q = i + pfx
		if pfx == 2 && i > 0 && s[i-1] == '+' {
			begin = i - 1
		}
		skipSeps := func(max int) {
			for units := 0; units < max; units++ {
				l := sepLen(s, q)
				if l == 0 {
					return
				}
				if l == 1 && s[q] == ')' {
					closeSeen = true
				}
				q += l
			}
		}
		skipSeps(3)
		if at(q) == '0' {
			q++
			skipSeps(2)
		}
	} else if at(i) == '0' && at(i+1) == '8' && i+2 < n && isDigit(s[i+2]) {
		q = i + 1
	} else {
		return 0, 0, false
	}
	if at(q) != '8' {
		return 0, 0, false
	}
	nd, validEnd, validClose, sepRun := 0, -1, false, 0
	limit := i + phoneLookahead
	if limit > n {
		limit = n
	}
	for j := q; j < limit; {
		c := s[j]
		if isDigit(c) {
			nd++
			if nd > phoneMaxNational {
				break
			}
			sepRun = 0
			j++
			if nd >= phoneMinNational {
				validEnd, validClose = j, closeSeen
			}
			continue
		}
		l := sepLen(s, j)
		sepRun++
		if l == 0 || sepRun > 2 {
			break
		}
		if l == 1 && c == ')' {
			closeSeen = true
		}
		j += l
	}
	if validEnd < 0 {
		return 0, 0, false
	}
	// Barcode-like chain: 20+ digits joined by single '-' or '.', candidate ends inside it.
	digits, k := 0, i
	chainLimit := i + phoneChainLookahead
	if chainLimit > n {
		chainLimit = n
	}
	for k < chainLimit {
		if isDigit(s[k]) {
			digits++
			k++
		} else if (s[k] == '-' || s[k] == '.') && k > i && k+1 < n && isDigit(s[k+1]) {
			k++
		} else {
			break
		}
	}
	if digits >= codeChainDigits && validEnd < k {
		return 0, 0, false
	}
	end = validEnd
	if begin > 0 && s[begin-1] == '(' {
		if validClose {
			begin--
		} else if end < n && s[end] == ')' {
			begin--
			end++
		}
	}
	return begin, end, true
}

// redactPhones redacts the UNION of every phone span (candidates at every token boundary),
// merging touching ones into one marker.
func redactPhones(str string) string {
	s := []rune(str)
	n := len(s)
	var b strings.Builder
	last, curB, curE := 0, -1, -1
	for i := 0; i < n; i++ {
		if !isDigit(s[i]) || (i > 0 && isDigit(s[i-1])) {
			continue
		}
		sb, se, ok := phoneSpanAt(s, i)
		if !ok {
			continue
		}
		if curB >= 0 && sb <= curE {
			if sb < curB {
				curB = sb
			}
			if se > curE {
				curE = se
			}
		} else {
			if curB >= 0 {
				b.WriteString(string(s[last:curB]))
				b.WriteString(Redacted)
				last = curE
			}
			curB, curE = sb, se
		}
	}
	if curB >= 0 {
		b.WriteString(string(s[last:curB]))
		b.WriteString(Redacted)
		last = curE
	}
	b.WriteString(string(s[last:]))
	return b.String()
}

// redactJWTs replaces JWTs (two or three base64url segments starting eyJ) in one linear pass.
func redactJWTs(s string) string {
	n := len(s)
	var out strings.Builder
	last, from := 0, 0
	for from < n {
		rel := strings.Index(s[from:], "eyJ")
		if rel < 0 {
			break
		}
		st := from + rel
		p := st + 3
		for p < n && isB64(s[p]) {
			p++
		}
		if p == st+3 || p >= n || s[p] != '.' {
			if p > st+3 {
				from = p
			} else {
				from = st + 3
			}
			continue
		}
		q := p + 1
		for q < n && isB64(s[q]) {
			q++
		}
		if q == p+1 {
			from = q
			continue
		}
		end := q
		if q < n && s[q] == '.' {
			end = q + 1
			for end < n && isB64(s[end]) {
				end++
			}
		}
		out.WriteString(s[last:st])
		out.WriteString(Redacted)
		last, from = end, end
	}
	out.WriteString(s[last:])
	return out.String()
}

// backslashesBefore counts the backslashes directly before s[i], not looking before floor.
func backslashesBefore(s string, i, floor int) int {
	r := 0
	for i-1-r >= floor && s[i-1-r] == '\\' {
		r++
	}
	return r
}

// jsonValueEnd is where the value after a secret key's colon ends (exclusive), starting at pos.
// keyEscapes is the number of backslashes before the key's quotes (0 = plain JSON, 1 = JSON
// inside a JSON string, 3 = twice nested, 7 = three times): string literals inside the value
// are then delimited by that many backslashes plus the quote. Object/array values end at their
// matching bracket, ignoring brackets inside string literals. Unterminated values run to the
// end of the string.
func jsonValueEnd(s string, pos, keyEscapes int) int {
	n := len(s)
	if pos >= n {
		return pos
	}
	isDelimiter := func(i, floor, k int) bool {
		r := backslashesBefore(s, i, floor)
		if k == 0 {
			return r%2 == 0
		}
		return r == k
	}
	if c := s[pos]; c == '{' || c == '[' {
		depth, inStr := 0, false
		for i := pos; i < n; i++ {
			d := s[i]
			switch {
			case d == '"':
				if isDelimiter(i, pos, keyEscapes) {
					inStr = !inStr
				}
			case inStr:
			case d == '{' || d == '[':
				depth++
			case d == '}' || d == ']':
				depth--
				if depth == 0 {
					return i + 1
				}
			}
		}
		return n
	}
	k := 0
	for pos+k < n && s[pos+k] == '\\' {
		k++
	}
	if pos+k < n && s[pos+k] == '"' {
		for i := pos + k + 1; i < n; i++ {
			if s[i] == '"' && isDelimiter(i, pos+k+1, k) {
				return i + 1
			}
		}
		return n
	}
	e := pos
	for e < n && !strings.ContainsRune(",}] \t\r\n\"\\", rune(s[e])) {
		e++
	}
	return e
}

func redactJSONSecrets(s string) string {
	var out strings.Builder
	last, from := 0, 0
	for from <= len(s) {
		loc := jsonKeyRE.FindStringSubmatchIndex(s[from:])
		if loc == nil {
			break
		}
		mStart, mEnd := from+loc[0], from+loc[1]
		end := jsonValueEnd(s, mEnd, loc[3]-loc[2])
		if end <= mEnd {
			from = mEnd
			continue
		}
		out.WriteString(s[last:mStart])
		out.WriteString(`"` + s[from+loc[4]:from+loc[5]] + `":"` + Redacted + `"`)
		last, from = end, end
	}
	out.WriteString(s[last:])
	return out.String()
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
			if isSecretKey(nk) || (w.t == Logs && (piiKeys[nk] || (personName && nk == "name"))) {
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
