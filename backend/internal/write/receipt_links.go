package write

import (
	"context"
	"fmt"
	"time"
)

// ReceiptLinkRow is one receipt_links insert. The token itself is never stored: TokenHash is its
// SHA-256, RecipientMasked keeps the last 4 digits, NetSalt/NetHash back the same-network flag.
type ReceiptLinkRow struct {
	OrderID, OutletID, CreatedBy, CreatedByName, DeviceID string
	TokenHash                                             []byte
	RecipientMasked, RecipientSource                      string
	NetSalt, NetHash                                      []byte
	ExpiresAt                                             time.Time
}

// InsertReceiptLink stores a link and returns its id and creation instant.
func (r *Repo) InsertReceiptLink(ctx context.Context, l ReceiptLinkRow) (id string, createdAt time.Time, err error) {
	var device any
	if l.DeviceID != "" {
		device = l.DeviceID
	}
	err = r.Pool.QueryRow(ctx,
		`INSERT INTO receipt_links (order_id, outlet_id, token_hash, recipient_masked, recipient_source,
		   created_by, created_by_name, device_id, net_salt, net_hash, expires_at)
		 VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8,$9,$10,$11)
		 RETURNING id::text, created_at`,
		l.OrderID, l.OutletID, l.TokenHash, l.RecipientMasked, l.RecipientSource,
		l.CreatedBy, l.CreatedByName, device, l.NetSalt, l.NetHash, l.ExpiresAt).Scan(&id, &createdAt)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("insert receipt link: %w", err)
	}
	return id, createdAt, nil
}

// OrderRatingRow is one order_ratings insert.
type OrderRatingRow struct {
	OrderID, LinkID, OutletID, SalesmanID, SalesmanName string
	BusinessDate                                        string // YYYY-MM-DD
	Stars                                               int
	Tags                                                []string
	Comment                                             string
	FlagFast, FlagSameNetwork                           bool
}

// InsertOrderRating stores the rating; the first one per order wins. inserted is false when the
// order already had a rating.
func (r *Repo) InsertOrderRating(ctx context.Context, o OrderRatingRow) (inserted bool, err error) {
	var sid, sname, comment any
	if o.SalesmanID != "" {
		sid = o.SalesmanID
	}
	if o.SalesmanName != "" {
		sname = o.SalesmanName
	}
	if o.Comment != "" {
		comment = o.Comment
	}
	tags := o.Tags
	if tags == nil {
		tags = []string{}
	}
	tag, err := r.Pool.Exec(ctx,
		`INSERT INTO order_ratings (order_id, link_id, outlet_id, salesman_id, salesman_name, business_date,
		   stars, tags, comment, flag_fast, flag_same_network)
		 VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::date,$7,$8,$9,$10,$11)
		 ON CONFLICT (order_id) DO NOTHING`,
		o.OrderID, o.LinkID, o.OutletID, sid, sname, o.BusinessDate, o.Stars, tags, comment, o.FlagFast, o.FlagSameNetwork)
	if err != nil {
		return false, fmt.Errorf("insert order rating: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// SetWaReceiptTemplate stores the WhatsApp message template; nil resets to the built-in default.
func (r *Repo) SetWaReceiptTemplate(ctx context.Context, tpl *string) error {
	if _, err := r.Pool.Exec(ctx, `UPDATE app_settings SET wa_receipt_template = $1 WHERE id = 1`, tpl); err != nil {
		return fmt.Errorf("set wa receipt template: %w", err)
	}
	return nil
}
