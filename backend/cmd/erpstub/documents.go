package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

const (
	maxBodyBytes = 1 << 20
	maxLines     = 200
)

var (
	uuidRe       = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	validKinds   = setOf("sale", "refund", "transfer_out", "transfer_in", "transfer_cancel", "receipt", "adjust", "count", "opening", "write_off")
	tenderMethod = setOf("cash", "card", "transfer", "qris")
)

func setOf(vals ...string) map[string]bool {
	m := make(map[string]bool, len(vals))
	for _, v := range vals {
		m[v] = true
	}
	return m
}

// jint decodes a JSON integer leniently: it never fails the whole decode, it
// records whether the value was present and a genuine integer (1.5, "5" and 1e3
// are not), so the validator can report a 422 instead of truncating silently.
type jint struct {
	Set   bool
	Valid bool
	Val   int64
}

func (j *jint) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "null" {
		return nil
	}
	j.Set = true
	if v, err := strconv.ParseInt(s, 10, 64); err == nil {
		j.Valid, j.Val = true, v
	}
	return nil
}

type docLine struct {
	MovementID string   `json:"movement_id"`
	FgCode     string   `json:"fg_code"`
	Qty        jint     `json:"qty"`
	QtyBefore  jint     `json:"qty_before"`
	QtyAfter   jint     `json:"qty_after"`
	UnitPrice  jint     `json:"unit_price"`
	Discount   jint     `json:"discount"`
	Reason     string   `json:"reason"`
	Flags      []string `json:"flags"`
}

type docTender struct {
	Method string `json:"method"`
	Amount jint   `json:"amount"`
}

type docPart struct {
	Index jint `json:"index"`
	Count jint `json:"count"`
}

type document struct {
	DocumentID string   `json:"document_id"`
	Kind       string   `json:"kind"`
	Part       *docPart `json:"part"`
	Source     struct {
		System   string `json:"system"`
		Brand    string `json:"brand"`
		DeviceID string `json:"device_id"`
		Actor    string `json:"actor"`
	} `json:"source"`
	Location   location    `json:"location"`
	OccurredAt string      `json:"occurred_at"`
	RecordedAt string      `json:"recorded_at"`
	Ref        docRef      `json:"ref"`
	Lines      []docLine   `json:"lines"`
	Tenders    []docTender `json:"tenders"`
}

// canonicalize returns the sha256 hex and canonical bytes of a JSON body.
// Go sorts map keys on marshal, so key order and whitespace do not matter.
func canonicalize(body []byte) (string, []byte, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", nil, err
	}
	canon, err := json.Marshal(v)
	if err != nil {
		return "", nil, err
	}
	sum := sha256.Sum256(canon)
	return hex.EncodeToString(sum[:]), canon, nil
}

type docResult struct {
	DocumentID  string   `json:"document_id"`
	Status      string   `json:"status"`
	MovementIDs []string `json:"movement_ids"`
}

func readDocument(w http.ResponseWriter, r *http.Request) (*document, string, []byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		msg := "could not read request body"
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			msg = "request body too large"
		}
		writeErr(w, http.StatusBadRequest, "INVALID_INPUT", msg, nil)
		return nil, "", nil, false
	}
	var doc document
	hash, canon, cerr := canonicalize(body)
	if cerr != nil || json.Unmarshal(body, &doc) != nil {
		writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "malformed JSON body", nil)
		return nil, "", nil, false
	}
	return &doc, hash, canon, true
}

func headerChecks(key string, doc *document) []detail {
	var ds []detail
	switch {
	case key == "":
		ds = append(ds, detail{"Idempotency-Key", "header is required"})
	case key != doc.DocumentID:
		ds = append(ds, detail{"Idempotency-Key", "must equal document_id"})
	}
	if !uuidRe.MatchString(doc.DocumentID) {
		ds = append(ds, detail{"document_id", "must be a UUID"})
	}
	if doc.Source.Brand == "" {
		ds = append(ds, detail{"source.brand", "is required"})
	}
	return ds
}

func (s *server) postStockDocument(w http.ResponseWriter, r *http.Request) {
	doc, hash, canon, ok := readDocument(w, r)
	if !ok {
		return
	}
	if ds := headerChecks(r.Header.Get("Idempotency-Key"), doc); len(ds) > 0 {
		writeValidation(w, ds)
		return
	}
	scope := "pos:" + doc.Source.Brand

	s.mu.Lock()
	defer s.mu.Unlock()
	if prev := s.st.findDoc(scope, doc.DocumentID); prev != nil {
		if prev.Hash != hash {
			writeErr(w, http.StatusConflict, "IDEMPOTENCY_CONFLICT", "document_id was already used with a different body", nil)
			return
		}
		writeOK(w, http.StatusOK, docResult{doc.DocumentID, "replayed", prev.MovementIDs})
		return
	}
	if ds := validateDoc(doc, scope, s.st); len(ds) > 0 {
		writeValidation(w, ds)
		return
	}
	rec := buildRecord(doc, scope, hash, canon, s.now().UTC())
	if err := s.commitLocked(func() { applyDoc(s.st, doc, rec) }); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "INTEGRATION_BUSY", "could not persist state, retry", nil)
		return
	}
	writeOK(w, http.StatusOK, docResult{doc.DocumentID, "applied", rec.MovementIDs})
}

func buildRecord(doc *document, scope, hash string, canon []byte, now time.Time) docRecord {
	rec := docRecord{
		Scope: scope, DocumentID: doc.DocumentID, Kind: doc.Kind, Location: doc.Location,
		Ref: doc.Ref, Hash: hash, ReceivedAt: now, Body: json.RawMessage(canon),
		MovementIDs: make([]string, 0, len(doc.Lines)),
	}
	if doc.Part != nil {
		rec.Part = &partInfo{Index: doc.Part.Index.Val, Count: doc.Part.Count.Val}
	}
	for _, l := range doc.Lines {
		rec.MovementIDs = append(rec.MovementIDs, l.MovementID)
	}
	return rec
}

// applyDoc stores the record, the movement ids and the balance deltas.
func applyDoc(st *state, doc *document, rec docRecord) {
	st.Documents = append(st.Documents, rec)
	for _, l := range doc.Lines {
		st.Movements[movementKey(rec.Scope, strings.ToLower(l.MovementID))] = rec.DocumentID
		key := balanceKey(doc.Location.Type, doc.Location.Slug, l.FgCode)
		b := st.Balances[key]
		if b == nil {
			b = &balance{LocationType: doc.Location.Type, LocationSlug: doc.Location.Slug, FgCode: l.FgCode}
			st.Balances[key] = b
		}
		b.Qty += l.Qty.Val
		b.UpdatedAt = rec.ReceivedAt
	}
}

type addFn func(path, msg string)

func validateDoc(doc *document, scope string, st *state) []detail {
	var ds []detail
	add := func(path, msg string) { ds = append(ds, detail{path, msg}) }
	validateHeaderFields(doc, st, add)
	validateLines(doc, scope, st, add)
	validateTenders(doc, add)
	return ds
}

func validateHeaderFields(doc *document, st *state, add addFn) {
	if !validKinds[doc.Kind] {
		add("kind", "unknown kind")
	}
	validateLocation(doc.Location, st, add)
	if _, err := time.Parse(time.RFC3339, doc.OccurredAt); err != nil {
		add("occurred_at", "required, RFC3339")
	}
	if doc.RecordedAt != "" {
		if _, err := time.Parse(time.RFC3339, doc.RecordedAt); err != nil {
			add("recorded_at", "must be RFC3339")
		}
	}
	if doc.Ref.Type == "" {
		add("ref.type", "is required")
	}
	if doc.Ref.ID == "" {
		add("ref.id", "is required")
	}
	if p := doc.Part; p != nil {
		if !p.Index.Valid || !p.Count.Valid || p.Index.Val < 1 || p.Index.Val > p.Count.Val {
			add("part", "requires integers with 1 <= index <= count")
		}
	}
}

func validateLocation(loc location, st *state, add addFn) {
	switch loc.Type {
	case "outlet":
		if st.findOutlet(func(o *erpapi.IntegrationOutlet) bool { return o.Slug == loc.Slug }) == nil {
			add("location.slug", "unknown outlet")
		}
	case "warehouse":
		if !st.hasWarehouse(loc.Slug) {
			add("location.slug", "unknown warehouse")
		}
	default:
		add("location.type", "must be outlet or warehouse")
	}
}

func validateLines(doc *document, scope string, st *state, add addFn) {
	if n := len(doc.Lines); n < 1 || n > maxLines {
		add("lines", "must contain 1 to 200 lines")
		return
	}
	seen := map[string]int{}
	for i, l := range doc.Lines {
		p := fmt.Sprintf("lines[%d].", i)
		validateMovementID(l.MovementID, scope, p, i, seen, st, add)
		if st.findFGByCode(l.FgCode, false) == nil {
			add(p+"fg_code", "unknown finished good")
		}
		if !l.Qty.Valid {
			add(p+"qty", "is required and must be an integer")
		}
		for name, v := range map[string]jint{"qty_before": l.QtyBefore, "qty_after": l.QtyAfter, "unit_price": l.UnitPrice, "discount": l.Discount} {
			if v.Set && !v.Valid {
				add(p+name, "must be an integer")
			}
		}
	}
}

func validateMovementID(id, scope, p string, idx int, seen map[string]int, st *state, add addFn) {
	if !uuidRe.MatchString(id) {
		add(p+"movement_id", "must be a UUID")
		return
	}
	k := strings.ToLower(id)
	if first, dup := seen[k]; dup {
		add(p+"movement_id", fmt.Sprintf("duplicate of lines[%d]", first))
	}
	seen[k] = idx
	if prev, ok := st.Movements[movementKey(scope, k)]; ok {
		add(p+"movement_id", "already applied in document "+prev)
	}
}

func validateTenders(doc *document, add addFn) {
	if len(doc.Tenders) == 0 {
		return
	}
	if doc.Kind != "sale" && doc.Kind != "refund" {
		add("tenders", "allowed only for sale and refund")
		return
	}
	for i, t := range doc.Tenders {
		p := fmt.Sprintf("tenders[%d].", i)
		if !tenderMethod[t.Method] {
			add(p+"method", "must be cash, card, transfer or qris")
		}
		if !t.Amount.Valid {
			add(p+"amount", "must be an integer")
		}
	}
}
