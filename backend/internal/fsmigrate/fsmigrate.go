// Package fsmigrate ports a Firestore export into PostgreSQL (Phase F cutover).
//
// Input is a single JSON document produced by the dump script in CUTOVER.md:
// one key per Firestore collection mapping to an array of documents; each
// document carries its Firestore string id under "id" plus its fields in the
// camelCase shape of packages/types. Singletons settings/app + settings/loyalty
// are passed as the objects "appSettings" and "loyaltySettings".
//
// Firestore string doc ids are mapped to deterministic UUIDv5 (fixed
// namespace) so the migration is idempotent and cross-document foreign keys
// (order.customerId, discountCode.promotionId, …) resolve without a lookup
// table. The whole run executes in ONE transaction: --dry-run rolls back so a
// staging parity check never mutates data.
package fsmigrate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Fixed namespace — never change once a production cutover has run, or ids drift.
var nsUUID = uuid.MustParse("8f6b6d2e-6d3a-5c41-9b2a-1f0c7e4d9a55")

// firebaseMigratedHash is an intentionally unverifiable password hash. Firebase
// auth was Google-popup (no password); migrated users must be re-provisioned /
// password-reset by an admin. auth.VerifyPassword rejects this deterministically.
const firebaseMigratedHash = "!firebase-migrated-no-password"

// Export is the parsed dump. Unknown keys are ignored; missing keys = 0 rows.
type Export struct {
	Outlets           []doc          `json:"outlets"`
	Categories        []doc          `json:"categories"`
	Products          []doc          `json:"products"`
	Bundles           []doc          `json:"bundles"`
	Customers         []doc          `json:"customers"`
	LoyaltyConditions []doc          `json:"loyaltyConditions"`
	Promotions        []doc          `json:"promotions"`
	DiscountCodes     []doc          `json:"discountCodes"`
	CustomRoles       []doc          `json:"customRoles"`
	Users             []doc          `json:"users"`
	Shifts            []doc          `json:"shifts"`
	Orders            []doc          `json:"orders"`
	StockCounts       []doc          `json:"stockCounts"`
	CashFlows         []doc          `json:"cashFlows"`
	SyncLogs          []doc          `json:"syncLogs"`
	Devices           []doc          `json:"devices"`
	AppSettings       map[string]any `json:"appSettings"`
	LoyaltySettings   map[string]any `json:"loyaltySettings"`
}

type doc = map[string]any

// Report is the per-collection parity + spot-check summary.
type Report struct {
	DryRun    bool
	Rows      map[string]int // table -> rows written
	Input     map[string]int // collection -> input docs
	Warnings  []string
	OrderSum  float64 // SUM(orders.total) post-load
	ShiftSum  float64 // SUM(shifts.total_sales) post-load
	OrderRows int
	ShiftRows int
}

// Load parses the export file.
func Load(path string) (*Export, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read export: %w", err)
	}
	var e Export
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if err := dec.Decode(&e); err != nil {
		return nil, fmt.Errorf("parse export json: %w", err)
	}
	return &e, nil
}

// Migrate applies the export in one transaction. dryRun rolls the tx back.
func Migrate(ctx context.Context, pool *pgxpool.Pool, e *Export, dryRun bool) (*Report, error) {
	r := &Report{DryRun: dryRun, Rows: map[string]int{}, Input: map[string]int{}}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	m := &mig{ctx: ctx, tx: tx, r: r}

	// Ensure a default outlet so NOT NULL outlet_id on legacy single-tenant
	// orders/shifts is always satisfiable.
	m.defaultOutlet = id("outlets", "default")
	m.exec(`INSERT INTO outlets (id,name,is_active) VALUES ($1,'Default Outlet',true)
	        ON CONFLICT (id) DO NOTHING`, m.defaultOutlet)

	m.outlets(e.Outlets)
	m.categories(e.Categories)
	m.products(e.Products)
	m.bundles(e.Bundles)
	m.customers(e.Customers)
	m.loyaltySettings(e.LoyaltySettings)
	m.loyaltyConditions(e.LoyaltyConditions)
	m.promotions(e.Promotions)
	m.discountCodes(e.DiscountCodes)
	m.customRoles(e.CustomRoles)
	m.users(e.Users)
	m.shifts(e.Shifts)
	m.orders(e.Orders)
	m.stockCounts(e.StockCounts)
	m.cashFlows(e.CashFlows)
	m.syncLogs(e.SyncLogs)
	m.devices(e.Devices)
	m.appSettings(e.AppSettings)

	if m.err != nil {
		return nil, m.err
	}

	// Spot-check aggregates inside the tx (so dry-run still verifies).
	_ = tx.QueryRow(ctx, `SELECT COALESCE(SUM(total),0), COUNT(*) FROM orders`).
		Scan(&r.OrderSum, &r.OrderRows)
	_ = tx.QueryRow(ctx, `SELECT COALESCE(SUM(total_sales),0), COUNT(*) FROM shifts`).
		Scan(&r.ShiftSum, &r.ShiftRows)

	if dryRun {
		r.warn("DRY-RUN: transaction rolled back, no data persisted")
		return r, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return r, nil
}

func (r *Report) warn(f string, a ...any) { r.Warnings = append(r.Warnings, fmt.Sprintf(f, a...)) }

// String renders the human-readable parity report.
func (r *Report) String() string {
	var b strings.Builder
	mode := "APPLIED"
	if r.DryRun {
		mode = "DRY-RUN (rolled back)"
	}
	fmt.Fprintf(&b, "Firestore→Postgres migration — %s\n", mode)
	b.WriteString("─────────────────────────────────────────────\n")
	keys := make([]string, 0, len(r.Rows))
	for k := range r.Rows {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		in, ok := r.Input[k]
		parity := ""
		if ok && in != r.Rows[k] {
			parity = fmt.Sprintf("  ⚠ input=%d", in)
		} else if ok {
			parity = fmt.Sprintf("  (input=%d ✓)", in)
		}
		fmt.Fprintf(&b, "  %-22s %6d rows%s\n", k, r.Rows[k], parity)
	}
	b.WriteString("─────────────────────────────────────────────\n")
	fmt.Fprintf(&b, "  orders: %d rows, SUM(total)=%.2f\n", r.OrderRows, r.OrderSum)
	fmt.Fprintf(&b, "  shifts: %d rows, SUM(total_sales)=%.2f\n", r.ShiftRows, r.ShiftSum)
	if len(r.Warnings) > 0 {
		b.WriteString("─────────────────────────────────────────────\n")
		for _, w := range r.Warnings {
			fmt.Fprintf(&b, "  ! %s\n", w)
		}
	}
	return b.String()
}

// ── migration runner ──────────────────────────────────────────

type mig struct {
	ctx           context.Context
	tx            pgx.Tx
	r             *Report
	err           error
	defaultOutlet uuid.UUID
}

func (m *mig) exec(sql string, args ...any) {
	if m.err != nil {
		return
	}
	if _, err := m.tx.Exec(m.ctx, sql, args...); err != nil {
		m.err = fmt.Errorf("exec failed: %w\n  sql: %s", err, strings.TrimSpace(sql))
	}
}

func (m *mig) count(table string, n int)      { m.r.Rows[table] += n }
func (m *mig) input(collection string, n int) { m.r.Input[collection] = n }
func (m *mig) warn(f string, a ...any)        { m.r.warn(f, a...) }

// id maps a Firestore (collection, docID) to a deterministic UUIDv5.
func id(collection, docID string) uuid.UUID {
	return uuid.NewSHA1(nsUUID, []byte(collection+":"+docID))
}

func docID(d doc) string {
	if v, ok := d["id"].(string); ok && v != "" {
		return v
	}
	return ""
}

// fk resolves a cross-collection reference; returns nil for empty input so
// nullable FK columns stay NULL instead of pointing at a phantom row.
func fk(collection string, raw any) *uuid.UUID {
	s, _ := raw.(string)
	if s == "" {
		return nil
	}
	u := id(collection, s)
	return &u
}

func (m *mig) resolveOutlet(raw any) uuid.UUID {
	s, _ := raw.(string)
	if s == "" || s == "default" {
		return m.defaultOutlet
	}
	return id("outlets", s)
}

// ── scalar coercion (Firestore export is loosely typed) ────────

func str(d doc, k string) *string {
	switch v := d[k].(type) {
	case string:
		if v == "" {
			return nil
		}
		return &v
	}
	return nil
}

func reqStr(d doc, k, def string) string {
	if s, ok := d[k].(string); ok && s != "" {
		return s
	}
	return def
}

func num(d doc, k string) float64 {
	switch v := d[k].(type) {
	case json.Number:
		f, _ := v.Float64()
		return f
	case float64:
		return v
	case string:
		var f float64
		fmt.Sscanf(v, "%g", &f)
		return f
	}
	return 0
}

func intv(d doc, k string) int { return int(num(d, k)) }

func boolv(d doc, k string) bool {
	b, _ := d[k].(bool)
	return b
}

// ts returns a timestamp arg Postgres can cast: RFC3339 string, epoch number,
// or Firestore {_seconds,_nanoseconds} → nil when absent (column default/NULL).
func ts(d doc, k string) any {
	switch v := d[k].(type) {
	case string:
		if v == "" {
			return nil
		}
		return v
	case json.Number:
		f, _ := v.Float64()
		return secsToISO(f)
	case float64:
		return secsToISO(v)
	case map[string]any:
		// Firestore Timestamp export shape: {_seconds, _nanoseconds}.
		return secsToISO(num(v, "_seconds"))
	}
	return nil
}

// secsToISO converts epoch seconds (Firestore Timestamp) to an RFC3339 string
// Postgres casts straight into timestamptz; nil when absent.
func secsToISO(sec float64) any {
	if sec <= 0 {
		return nil
	}
	return time.Unix(int64(sec), 0).UTC().Format(time.RFC3339)
}

// jsonbOrNil marshals a slice/object field to JSON for jsonb columns; nil when
// absent so the column stays NULL.
func jsonbOrNil(d doc, k string) any {
	v, ok := d[k]
	if !ok || v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return string(b)
}

func strSlice(d doc, k string) []string {
	raw, ok := d[k].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, x := range raw {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func items(d doc, k string) []doc {
	raw, ok := d[k].([]any)
	if !ok {
		return nil
	}
	out := make([]doc, 0, len(raw))
	for _, x := range raw {
		if mm, ok := x.(map[string]any); ok {
			out = append(out, mm)
		}
	}
	return out
}
