package erpstub

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

const (
	maxBodyBytes  = 512 << 10 // the ERP answers 413 above 512 KB
	maxLines      = 200
	maxAheadOfNow = 24 * time.Hour
	maxMonthsBack = 6
)

var (
	uuidRe       = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	validKinds   = setOf("sale", "refund", "transfer_out", "transfer_in", "transfer_cancel", "receipt", "adjust", "count", "opening", "write_off")
	tenderMethod = setOf("cash", "card", "transfer", "qris")
	// signByKind is the sign each kind allows (zero is always allowed):
	// "out" means qty <= 0, "in" means qty >= 0.
	signByKind = map[string]string{
		"sale": "out", "refund": "in", "transfer_out": "out", "transfer_in": "in", "transfer_cancel": "in",
		"receipt": "in", "adjust": "any", "count": "any", "opening": "any", "write_off": "out",
	}
	// wib is Asia/Jakarta (fixed UTC+7, no DST); never LoadLocation, so no tzdata is needed.
	wib = time.FixedZone("WIB", 7*3600)
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
// Like the ERP, document_id, movement_id and refund_of_movement_id are
// lowercased first: a UUID is case-insensitive, so a retry that only changes id
// case replays instead of conflicting. (The ERP hashes the schema-parsed body,
// which drops unknown keys; the stub hashes every key it was sent.)
func canonicalize(body []byte) (string, []byte, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", nil, err
	}
	lowerIDs(v)
	canon, err := json.Marshal(v)
	if err != nil {
		return "", nil, err
	}
	sum := sha256.Sum256(canon)
	return hex.EncodeToString(sum[:]), canon, nil
}

func lowerIDs(v any) {
	m, ok := v.(map[string]any)
	if !ok {
		return
	}
	lowerField(m, "document_id")
	lines, _ := m["lines"].([]any)
	for _, l := range lines {
		if lm, ok := l.(map[string]any); ok {
			lowerField(lm, "movement_id")
			lowerField(lm, "refund_of_movement_id")
		}
	}
}

func lowerField(m map[string]any, key string) {
	if s, ok := m[key].(string); ok {
		m[key] = strings.ToLower(s)
	}
}

type docResult struct {
	DocumentID  string   `json:"document_id"`
	Status      string   `json:"status"`
	MovementIDs []string `json:"movement_ids"`
}

func readDocument(w http.ResponseWriter, r *http.Request) (*document, string, []byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeErr(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body too large", nil)
		} else {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "could not read request body", nil)
		}
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

// keyChecks is the Idempotency-Key stage: the header must equal document_id,
// ignoring letter case (a UUID is case-insensitive).
func keyChecks(key string, doc *document) []detail {
	switch {
	case key == "":
		return []detail{{"Idempotency-Key", "header is required"}}
	case !strings.EqualFold(key, doc.DocumentID):
		return []detail{{"Idempotency-Key", "must equal document_id"}}
	}
	return nil
}

// postStockDocument applies the ERP's stages in order and stops at the first
// failing one, so the issues of one stage are never mixed with another's: body
// size, schema, Idempotency-Key, replay, outlet, sign, period, fg_code, movement ids.
func (s *Server) postStockDocument(w http.ResponseWriter, r *http.Request) {
	doc, hash, canon, ok := readDocument(w, r)
	if !ok {
		return
	}
	if ds := schemaChecks(doc); len(ds) > 0 {
		writeValidation(w, ds)
		return
	}
	if ds := keyChecks(r.Header.Get("Idempotency-Key"), doc); len(ds) > 0 {
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
		s.writeDocOK(w, docResult{doc.DocumentID, "replayed", prev.MovementIDs})
		return
	}
	outlet, ds := s.resolveOutlet(w, doc.Location)
	if len(ds) > 0 {
		writeValidation(w, ds)
		return
	}
	period, ds := s.laterStages(doc, scope)
	if len(ds) > 0 {
		writeValidation(w, ds)
		return
	}
	doc.Location = location{Type: "outlet", Code: outlet.Code, Slug: outlet.Slug}
	rec := buildRecord(doc, scope, hash, canon, s.now().UTC(), period)
	if err := s.commitLocked(func() { applyDoc(s.st, doc, rec) }); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "INTEGRATION_BUSY", "could not persist state, retry", nil)
		return
	}
	s.writeDocOK(w, docResult{doc.DocumentID, "applied", rec.MovementIDs})
}

const outletRefused = "Outlet tidak dikenal atau tidak diatur untuk client ini"

// resolveOutlet is the outlet stage: the code must name a live outlet assigned
// to this client, else exactly one location.code issue (one message for every
// refusal). An empty code with a slug is the deprecated slug alias. Caller holds s.mu.
func (s *Server) resolveOutlet(w http.ResponseWriter, loc location) (*erpapi.IntegrationOutlet, []detail) {
	code, slug := strings.TrimSpace(loc.Code), strings.TrimSpace(loc.Slug)
	var o *erpapi.IntegrationOutlet
	if code != "" {
		o = s.st.findOutlet(func(x *erpapi.IntegrationOutlet) bool { return x.Code == code })
	} else {
		log.Printf("erpstub: location.slug %q is deprecated; send location.code", slug)
		w.Header().Set("Warning", `299 - "location.slug is deprecated; send location.code"`)
		o = s.st.findOutlet(func(x *erpapi.IntegrationOutlet) bool { return x.Slug == slug })
	}
	if o == nil || (s.assigned != nil && !s.assigned[o.Code]) {
		return nil, []detail{{"location.code", outletRefused}}
	}
	return o, nil
}

// laterStages runs sign, period, fg_code and movement-id reuse, each stopping
// the request with only its own issues. It returns the period (YYYY-MM, Jakarta).
func (s *Server) laterStages(doc *document, scope string) (string, []detail) {
	if ds := signChecks(doc); len(ds) > 0 {
		return "", ds
	}
	period, ds := periodOf(doc.OccurredAt, s.now())
	if len(ds) > 0 {
		return "", ds
	}
	if ds := fgChecks(doc, s.st); len(ds) > 0 {
		return "", ds
	}
	return period, movementReuseChecks(doc, scope, s.st)
}

func buildRecord(doc *document, scope, hash string, canon []byte, now time.Time, period string) docRecord {
	rec := docRecord{
		Scope: scope, DocumentID: doc.DocumentID, Kind: doc.Kind, Location: doc.Location, PeriodMonth: period,
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

// applyDoc stores the record, the movement ids and the balance deltas. A zero
// line writes no movement and no balance, and does not reserve its id.
func applyDoc(st *state, doc *document, rec docRecord) {
	st.Documents = append(st.Documents, rec)
	for _, l := range doc.Lines {
		if l.Qty.Val == 0 {
			continue
		}
		st.Movements[movementKey(rec.Scope, strings.ToLower(l.MovementID))] = rec.DocumentID
		key := balanceKey(doc.Location.Type, doc.Location.Code, l.FgCode)
		b := st.Balances[key]
		if b == nil {
			b = &balance{LocationType: doc.Location.Type, LocationCode: doc.Location.Code, LocationSlug: doc.Location.Slug, FgCode: l.FgCode}
			st.Balances[key] = b
		}
		b.Qty += l.Qty.Val
		b.UpdatedAt = rec.ReceivedAt
	}
}

type addFn func(path, msg string)

// schemaChecks is the structural stage: all issues together (the ERP's zod
// stage plus the stub's extra checks on ref, part, tenders and source.brand).
func schemaChecks(doc *document) []detail {
	var ds []detail
	add := func(path, msg string) { ds = append(ds, detail{path, msg}) }
	if !uuidRe.MatchString(doc.DocumentID) {
		add("document_id", "must be a UUID")
	}
	if doc.Source.Brand == "" {
		add("source.brand", "is required")
	}
	if !validKinds[doc.Kind] {
		add("kind", "unknown kind")
	}
	validateLocationShape(doc.Location, add)
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
	validateLines(doc, add)
	validateTenders(doc, add)
	return ds
}

// validateLocationShape: type must be outlet (a warehouse document is a schema
// error, as in the ERP); a code is required unless the deprecated slug alias is sent.
func validateLocationShape(loc location, add addFn) {
	if loc.Type != "outlet" {
		add("location.type", "must be outlet")
	}
	if strings.TrimSpace(loc.Code) == "" && strings.TrimSpace(loc.Slug) == "" {
		add("location.code", "is required")
	}
}

func validateLines(doc *document, add addFn) {
	if n := len(doc.Lines); n < 1 || n > maxLines {
		add("lines", "must contain 1 to 200 lines")
		return
	}
	seen := map[string]int{}
	for i, l := range doc.Lines {
		p := fmt.Sprintf("lines[%d].", i)
		validateMovementID(l.MovementID, p, i, seen, add)
		if l.FgCode == "" {
			add(p+"fg_code", "is required")
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

// validateMovementID flags a bad UUID and a duplicate inside the document
// (case-insensitive, whatever the qty).
func validateMovementID(id, p string, idx int, seen map[string]int, add addFn) {
	if !uuidRe.MatchString(id) {
		add(p+"movement_id", "must be a UUID")
		return
	}
	k := strings.ToLower(id)
	if first, dup := seen[k]; dup {
		add(p+"movement_id", fmt.Sprintf("duplicate of lines[%d]", first))
	}
	seen[k] = idx
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

// signChecks: one issue per line whose qty has the wrong sign for the kind.
func signChecks(doc *document) []detail {
	sign := signByKind[doc.Kind]
	var ds []detail
	for i, l := range doc.Lines {
		q := l.Qty.Val
		switch {
		case sign == "out" && q > 0:
			ds = append(ds, detail{fmt.Sprintf("lines[%d].qty", i), "qty " + doc.Kind + " harus ≤ 0"})
		case sign == "in" && q < 0:
			ds = append(ds, detail{fmt.Sprintf("lines[%d].qty", i), "qty " + doc.Kind + " harus ≥ 0"})
		}
	}
	return ds
}

// monthStart is the first instant of t's Jakarta month.
func monthStart(t time.Time) time.Time {
	t = t.In(wib)
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, wib)
}

// periodOf resolves the stock period (YYYY-MM, Jakarta) of occurred_at: more
// than 24 h ahead of now is refused; up to 24 h ahead counts as now's month;
// the period may be at most 6 Jakarta months before the current one.
func periodOf(occurredAt string, now time.Time) (string, []detail) {
	occ, err := time.Parse(time.RFC3339, occurredAt)
	if err != nil {
		return "", []detail{{"occurred_at", "required, RFC3339"}}
	}
	if occ.After(now.Add(maxAheadOfNow)) {
		return "", []detail{{"occurred_at", "occurred_at lebih dari 24 jam ke depan"}}
	}
	ref := occ
	if occ.After(now) {
		ref = now
	}
	period := monthStart(ref)
	cur := monthStart(now)
	earliest := time.Date(cur.Year(), cur.Month()-maxMonthsBack, 1, 0, 0, 0, 0, wib)
	if period.Before(earliest) {
		return "", []detail{{"occurred_at", fmt.Sprintf("occurred_at lebih lama dari %d bulan", maxMonthsBack)}}
	}
	return period.Format("2006-01"), nil
}

// fgChecks: a known fg_code; like the ERP (BR7) an FG in trash is still accepted.
func fgChecks(doc *document, st *state) []detail {
	var ds []detail
	for i, l := range doc.Lines {
		if st.findFGByCode(l.FgCode, true) == nil {
			ds = append(ds, detail{fmt.Sprintf("lines[%d].fg_code", i), "unknown finished good"})
		}
	}
	return ds
}

// movementReuseChecks: a NONZERO line whose movement_id this client already used.
func movementReuseChecks(doc *document, scope string, st *state) []detail {
	var ds []detail
	for i, l := range doc.Lines {
		if l.Qty.Val == 0 {
			continue
		}
		if prev, ok := st.Movements[movementKey(scope, strings.ToLower(l.MovementID))]; ok {
			ds = append(ds, detail{fmt.Sprintf("lines[%d].movement_id", i), "already applied in document " + prev})
		}
	}
	return ds
}
