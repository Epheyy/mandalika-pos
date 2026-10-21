package write

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

type DiscountCode struct {
	Code             string   `json:"code"`
	PromotionID      string   `json:"promotionId"`
	Type             string   `json:"type"`
	Value            float64  `json:"value"`
	MinPurchase      *float64 `json:"minPurchase"`
	UsageLimit       *int     `json:"usageLimit"`
	IsActive         bool     `json:"isActive"`
	StartDate        string   `json:"startDate"`
	EndDate          string   `json:"endDate"`
	Combinable       bool     `json:"combinable"`       // SP-Promo-3a: may this code stack with other combinable discounts
	PerCustomerLimit *int     `json:"perCustomerLimit"` // SP-Code-3: max redemptions per customer (nil = unlimited)
	CustomerID       string   `json:"customerId"`       // SP-Code-4: assign this code to one customer (empty = unassigned)
}

func (r *Repo) CreateDiscountCode(ctx context.Context, d DiscountCode) (string, error) {
	var id string
	err := r.tx(ctx, "discountCodes", func(t pgx.Tx) error {
		return t.QueryRow(ctx, `
			INSERT INTO discount_codes (code, promotion_id, type, value,
			  min_purchase, usage_limit, is_active, start_date, end_date, combinable,
			  per_customer_limit, customer_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
			d.Code, nullUUID(d.PromotionID), d.Type, d.Value, d.MinPurchase,
			d.UsageLimit, d.IsActive, nullDate(d.StartDate), nullDate(d.EndDate), d.Combinable,
			d.PerCustomerLimit, nullUUID(d.CustomerID)).
			Scan(&id)
	})
	return id, err
}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no O,0,1,I

// randSuffix returns a length-n string over codeAlphabet using crypto/rand.
// (Unbiased rejection sampling is overkill for a 32-char alphabet; the mod
// bias here is negligible.)
func randSuffix(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand should never fail. This fallback yields a CONSTANT string,
		// which would mass-collide — but with the ON CONFLICT DO NOTHING insert in
		// CreateDiscountCodeBatch that just makes every regenerate hit the same
		// existing row, exhausting retries and cleanly aborting the whole batch
		// (no partial write, no poisoned tx). Safe, if degenerate.
		for i := range b {
			b[i] = byte(i)
		}
	}
	out := make([]byte, n)
	for i, x := range b {
		out[i] = codeAlphabet[int(x)%len(codeAlphabet)]
	}
	return string(out)
}

// DiscountCodeBatch embeds DiscountCode for the shared settings applied to every
// generated code; the embedded Code field is unused/ignored (each code is
// generated server-side as Prefix + randSuffix(SuffixLength)).
type DiscountCodeBatch struct {
	DiscountCode
	Count        int    `json:"count"`
	Prefix       string `json:"prefix"`
	SuffixLength int    `json:"suffixLength"`
}

// CreatedCode is one successfully-inserted code returned to the caller.
type CreatedCode struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	CreatedAt string `json:"createdAt"`
}

var prefixRe = regexp.MustCompile(`^[A-Z0-9]*$`)

func validateDiscountCodeBatch(b DiscountCodeBatch) error {
	if b.Count < 1 || b.Count > 500 {
		return fmt.Errorf("count must be 1..500")
	}
	if b.SuffixLength < 4 || b.SuffixLength > 12 {
		return fmt.Errorf("suffixLength must be 4..12")
	}
	if len(b.Prefix) > 16 || !prefixRe.MatchString(strings.ToUpper(b.Prefix)) {
		return fmt.Errorf("prefix must be alphanumeric, max 16 chars")
	}
	if b.Type != "percentage" && b.Type != "fixed" {
		return fmt.Errorf("type must be percentage or fixed")
	}
	return nil
}

// CreateDiscountCodeBatch generates b.Count unique discount codes server-side and
// inserts them in a single transaction. Every code shares the batch's settings;
// only the string differs. Each INSERT uses ON CONFLICT (code) DO NOTHING so a
// UNIQUE(code) collision does NOT raise an error (which would poison the shared
// tx with SQLSTATE 25P02) — it inserts nothing and returns no row. That no-row
// case (pgx.ErrNoRows) regenerates the suffix and retries (up to 10 attempts per
// code); any other DB error, or retry exhaustion, aborts the whole transaction —
// the batch is all-or-nothing, never partial.
func (r *Repo) CreateDiscountCodeBatch(ctx context.Context, b DiscountCodeBatch) ([]CreatedCode, error) {
	if err := validateDiscountCodeBatch(b); err != nil {
		return nil, err
	}
	prefix := strings.ToUpper(b.Prefix)
	out := make([]CreatedCode, 0, b.Count)
	err := r.tx(ctx, "discountCodes", func(t pgx.Tx) error {
		for i := 0; i < b.Count; i++ {
			var id, code, createdAt string
			inserted := false
			for attempt := 0; attempt < 10 && !inserted; attempt++ {
				code = prefix + randSuffix(b.SuffixLength)
				e := t.QueryRow(ctx, `
					INSERT INTO discount_codes (code, promotion_id, type, value,
					  min_purchase, usage_limit, is_active, start_date, end_date, combinable,
					  per_customer_limit)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
					ON CONFLICT (code) DO NOTHING
					RETURNING id, code, created_at::text`,
					code, nullUUID(b.PromotionID), b.Type, b.Value, b.MinPurchase,
					b.UsageLimit, b.IsActive, nullDate(b.StartDate), nullDate(b.EndDate), b.Combinable,
					b.PerCustomerLimit).
					Scan(&id, &code, &createdAt)
				if e == nil {
					inserted = true
					break
				}
				if errors.Is(e, pgx.ErrNoRows) { // conflict → no row inserted → regenerate
					continue
				}
				return e // other error → abort tx
			}
			if !inserted {
				return fmt.Errorf("could not generate a unique code after retries")
			}
			out = append(out, CreatedCode{ID: id, Code: code, CreatedAt: createdAt})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) UpdateDiscountCode(ctx context.Context, id string, d DiscountCode) error {
	return r.tx(ctx, "discountCodes", func(t pgx.Tx) error {
		ct, e := t.Exec(ctx, `
			UPDATE discount_codes SET code=$1, promotion_id=$2, type=$3, value=$4,
			  min_purchase=$5, usage_limit=$6, is_active=$7, start_date=$8,
			  end_date=$9, combinable=$10, per_customer_limit=$11, customer_id=$12 WHERE id=$13`,
			d.Code, nullUUID(d.PromotionID), d.Type, d.Value, d.MinPurchase,
			d.UsageLimit, d.IsActive, nullDate(d.StartDate), nullDate(d.EndDate), d.Combinable,
			d.PerCustomerLimit, nullUUID(d.CustomerID), id)
		if e == nil && ct.RowsAffected() == 0 {
			return ErrNotFound
		}
		return e
	})
}

func (r *Repo) DeleteDiscountCode(ctx context.Context, id string) error {
	return r.delete(ctx, "discountCodes", "discount_codes", id)
}
