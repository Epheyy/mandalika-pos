package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultTake    = 100
	maxTake        = 500
	maxListCodes   = 100
	maxListChars   = 1900
	maxSearchChars = 100

	modeFull  = "full"
	modeInc   = "inc"
	modeStock = "stock"
)

// cursorToken is the decoded form of the opaque keyset cursor.
type cursorToken struct {
	M string `json:"m"`
	S string `json:"s"`
	U string `json:"u,omitempty"`
}

func encodeCursor(c cursorToken) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(raw string) (cursorToken, error) {
	var c cursorToken
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	return c, nil
}

// catParams are the parsed, validated catalog query parameters.
type catParams struct {
	take      int
	mode      string
	since     time.Time
	cursor    *cursorToken
	curTime   time.Time
	codes     map[string]bool
	search    string
	hasSearch bool
}

func parseTake(q url.Values) (int, *detail) {
	if !q.Has("take") {
		return defaultTake, nil
	}
	n, err := strconv.Atoi(q.Get("take"))
	if err != nil || n < 1 || n > maxTake {
		return 0, &detail{Path: "take", Message: "must be an integer between 1 and 500"}
	}
	return n, nil
}

// parseCodeList splits a comma separated list: 1..100 unique non-empty codes, <=1900 chars.
func parseCodeList(raw, path string) ([]string, *detail) {
	if len(raw) > maxListChars {
		return nil, &detail{Path: path, Message: "list is too long"}
	}
	seen := map[string]bool{}
	var out []string
	for _, c := range strings.Split(raw, ",") {
		if c == "" {
			return nil, &detail{Path: path, Message: "codes must be non-empty"}
		}
		if seen[c] {
			return nil, &detail{Path: path, Message: "codes must be unique"}
		}
		seen[c] = true
		out = append(out, c)
	}
	if len(out) < 1 || len(out) > maxListCodes {
		return nil, &detail{Path: path, Message: "must contain 1 to 100 codes"}
	}
	return out, nil
}

func parseCatalogParams(q url.Values) (catParams, []detail) {
	p := catParams{mode: modeFull}
	var ds []detail
	add := func(d *detail) {
		if d != nil {
			ds = append(ds, *d)
		}
	}
	take, d := parseTake(q)
	add(d)
	p.take = take
	if q.Has("updated_since") {
		t, err := time.Parse(time.RFC3339, q.Get("updated_since"))
		if err != nil {
			add(&detail{Path: "updated_since", Message: "must be an RFC3339 timestamp"})
		} else {
			p.since, p.mode = t, modeInc
		}
	}
	add(parseCatalogFilters(q, &p))
	add(parseCursorParam(q, &p))
	return p, ds
}

func parseCatalogFilters(q url.Values, p *catParams) *detail {
	if q.Has("codes") {
		list, d := parseCodeList(q.Get("codes"), "codes")
		if d != nil {
			return d
		}
		p.codes = map[string]bool{}
		for _, c := range list {
			p.codes[c] = true
		}
	}
	if q.Has("search") {
		s := q.Get("search")
		if n := len([]rune(s)); n < 1 || n > maxSearchChars {
			return &detail{Path: "search", Message: "must be 1 to 100 characters"}
		}
		p.search, p.hasSearch = strings.ToLower(s), true
	}
	return nil
}

func parseCursorParam(q url.Values, p *catParams) *detail {
	if !q.Has("cursor") {
		return nil
	}
	c, err := decodeCursor(q.Get("cursor"))
	if err != nil || c.M != p.mode {
		return &detail{Path: "cursor", Message: "invalid cursor for this request mode"}
	}
	if p.mode == modeInc {
		t, err := time.Parse(time.RFC3339Nano, c.U)
		if err != nil {
			return &detail{Path: "cursor", Message: "invalid cursor"}
		}
		p.curTime = t
	}
	p.cursor = &c
	return nil
}

// catRec is the common projection of finished goods and outlets.
type catRec struct {
	slug, code, name string
	updated          time.Time
	deleted          bool
	item             any
}

func fgRecs(st *state) []catRec {
	out := make([]catRec, 0, len(st.FinishedGoods))
	for _, f := range st.FinishedGoods {
		out = append(out, catRec{f.Slug, f.Code, f.Name, f.UpdatedAt, f.DeletedAt != nil, f})
	}
	return out
}

func outletRecs(st *state) []catRec {
	out := make([]catRec, 0, len(st.Outlets))
	for _, o := range st.Outlets {
		out = append(out, catRec{o.Slug, o.Code, o.Name, o.UpdatedAt, o.DeletedAt != nil, o})
	}
	return out
}

// matchRec applies mode and filters. search is a plain case-insensitive
// substring match, so '%' and '_' are literal characters (no LIKE semantics).
func matchRec(r catRec, p catParams) bool {
	if p.mode == modeFull && r.deleted {
		return false
	}
	if p.mode == modeInc && !r.updated.After(p.since) {
		return false
	}
	if p.codes != nil && !p.codes[r.code] {
		return false
	}
	if p.hasSearch {
		return strings.Contains(strings.ToLower(r.code), p.search) ||
			strings.Contains(strings.ToLower(r.name), p.search)
	}
	return true
}

func sortRecs(recs []catRec, mode string) {
	sort.Slice(recs, func(i, j int) bool {
		if mode == modeInc && !recs[i].updated.Equal(recs[j].updated) {
			return recs[i].updated.Before(recs[j].updated)
		}
		return recs[i].slug < recs[j].slug
	})
}

func afterCursor(recs []catRec, p catParams) []catRec {
	for i, r := range recs {
		if p.mode == modeFull && r.slug > p.cursor.S {
			return recs[i:]
		}
		if p.mode == modeInc && (r.updated.After(p.curTime) || (r.updated.Equal(p.curTime) && r.slug > p.cursor.S)) {
			return recs[i:]
		}
	}
	return nil
}

func cursorFor(r catRec, mode string) string {
	c := cursorToken{M: mode, S: r.slug}
	if mode == modeInc {
		c.U = r.updated.UTC().Format(time.RFC3339Nano)
	}
	return encodeCursor(c)
}

func selectPage(recs []catRec, p catParams) ([]any, *string) {
	var out []catRec
	for _, r := range recs {
		if matchRec(r, p) {
			out = append(out, r)
		}
	}
	sortRecs(out, p.mode)
	if p.cursor != nil {
		out = afterCursor(out, p)
	}
	var next *string
	if len(out) > p.take {
		out = out[:p.take]
		c := cursorFor(out[len(out)-1], p.mode)
		next = &c
	}
	items := make([]any, 0, len(out))
	for _, r := range out {
		items = append(items, r.item)
	}
	return items, next
}

type catalogPage struct {
	Items      []any   `json:"items"`
	NextCursor *string `json:"next_cursor"`
	ServerTime string  `json:"server_time"`
}

func (s *server) catalogHandler(build func(*state) []catRec) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ds := parseCatalogParams(r.URL.Query())
		if len(ds) > 0 {
			writeValidation(w, ds)
			return
		}
		s.mu.Lock()
		recs := build(s.st)
		s.mu.Unlock()
		items, next := selectPage(recs, p)
		writeCatalog(w, catalogPage{Items: items, NextCursor: next, ServerTime: s.now().UTC().Format(time.RFC3339Nano)})
	}
}
