package read

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ReceiptOrder is what link creation needs of an order. CustomerPhone is read here only to build
// the WhatsApp address; it is never stored on a link or sent back to the client.
type ReceiptOrder struct {
	ID, OrderNumber, OutletID, OutletName string
	CustomerName, CustomerPhone           string
	SalesmanName, Status                  string
	// BusinessDate is the sale's business day (YYYY-MM-DD, outlet zone), Zone the outlet timezone.
	BusinessDate, Zone string
	Total              float64
}

// ReceiptLinkOrder finds the order a link is being made for, inside the caller's outlet scope
// (like Repo.Order). byUUID selects the client order uuid instead of the server id. ErrNotFound
// when no order in scope matches.
func (r *Repo) ReceiptLinkOrder(ctx context.Context, sc Scope, byUUID bool, id string) (ReceiptOrder, error) {
	col := "o.id"
	if byUUID {
		col = "o.order_uuid"
	}
	args := []any{id}
	cond := ""
	if !sc.CrossAll {
		args = append(args, sc.OutletID)
		cond = " AND o.outlet_id = $2::uuid"
	}
	var o ReceiptOrder
	err := r.Pool.QueryRow(ctx,
		`SELECT o.id::text, o.order_number, o.outlet_id::text, ou.name,
		        COALESCE(NULLIF(btrim(COALESCE(o.customer_name,'')),''), c.name, ''), COALESCE(c.phone,''),
		        COALESCE(o.salesman_name,''), o.status, COALESCE(o.business_date::text,''), ou.timezone, o.total::float8
		   FROM orders o
		   JOIN outlets ou ON ou.id = o.outlet_id
		   LEFT JOIN customers c ON c.id = o.customer_id
		  WHERE `+col+` = $1::uuid`+cond, args...).
		Scan(&o.ID, &o.OrderNumber, &o.OutletID, &o.OutletName, &o.CustomerName, &o.CustomerPhone,
			&o.SalesmanName, &o.Status, &o.BusinessDate, &o.Zone, &o.Total)
	if errors.Is(err, pgx.ErrNoRows) {
		return o, ErrNotFound
	}
	if err != nil {
		return o, fmt.Errorf("receipt link order: %w", err)
	}
	return o, nil
}

// ReceiptLinkInfo is a live (unexpired) link with the order facts a rating needs and the existing
// rating, if any.
type ReceiptLinkInfo struct {
	LinkID, OrderID, OutletID string
	CreatedAt                 time.Time
	NetSalt, NetHash          []byte
	SalesmanID, SalesmanName  string
	BusinessDate              string // YYYY-MM-DD, outlet zone
	Rated                     bool
	Stars                     int
	Tags                      []string
	Comment                   string
}

// ReceiptLinkByHash resolves a token hash to its link. Unknown and expired both give ErrNotFound,
// so the caller cannot tell them apart.
func (r *Repo) ReceiptLinkByHash(ctx context.Context, hash []byte) (ReceiptLinkInfo, error) {
	var li ReceiptLinkInfo
	var stars *int
	var tags []string
	var comment *string
	err := r.Pool.QueryRow(ctx,
		`SELECT l.id::text, l.order_id::text, l.outlet_id::text, l.created_at, l.net_salt, l.net_hash,
		        COALESCE(o.salesman_id::text,''), COALESCE(o.salesman_name,''), o.business_date::text,
		        rt.stars::int, rt.tags, rt.comment
		   FROM receipt_links l
		   JOIN orders o ON o.id = l.order_id
		   LEFT JOIN order_ratings rt ON rt.order_id = l.order_id
		  WHERE l.token_hash = $1 AND l.expires_at > now()`, hash).
		Scan(&li.LinkID, &li.OrderID, &li.OutletID, &li.CreatedAt, &li.NetSalt, &li.NetHash,
			&li.SalesmanID, &li.SalesmanName, &li.BusinessDate, &stars, &tags, &comment)
	if errors.Is(err, pgx.ErrNoRows) {
		return li, ErrNotFound
	}
	if err != nil {
		return li, fmt.Errorf("receipt link by hash: %w", err)
	}
	if stars != nil {
		li.Rated, li.Stars, li.Tags = true, *stars, tags
		if comment != nil {
			li.Comment = *comment
		}
	}
	return li, nil
}

// ReceiptLine is one line of the public receipt.
type ReceiptLine struct {
	Name, Variant string
	Qty           int
	Subtotal      float64
}

// ReceiptPageData is the order as the public page shows it. CustomerFirstName is the first word of
// the name only; nothing else about the customer leaves the database.
type ReceiptPageData struct {
	Brand, OutletName, OrderNumber  string
	CreatedAt                       time.Time
	Zone                            string
	Lines                           []ReceiptLine
	Subtotal, Discount, Tax, Total  float64
	Surcharge, PointsRedeemed       float64
	Payment                         string
	CustomerFirstName, SalesmanName string
	// LogoURL is the brand logo source (Pengaturan > Dokumen); "" = none.
	LogoURL string
}

// ReceiptPage reads what the public receipt page shows for an order.
func (r *Repo) ReceiptPage(ctx context.Context, orderID string) (ReceiptPageData, error) {
	var d ReceiptPageData
	var brand, customer string
	var method string
	var pm []byte
	err := r.Pool.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(btrim(a.documents_brand_name),''), ou.name), ou.name, o.order_number, o.created_at, ou.timezone,
		        o.subtotal::float8, o.discount_amount::float8, o.tax_amount::float8, o.total::float8,
		        o.surcharge_amount::float8, COALESCE(o.points_redemption_amount,0)::float8,
		        o.payment_method, COALESCE(a.payment_methods,'[]'::jsonb),
		        COALESCE(NULLIF(btrim(COALESCE(o.customer_name,'')),''), c.name, ''), COALESCE(o.salesman_name,''),
		        COALESCE(btrim(a.documents_logo_url),'')
		   FROM orders o
		   JOIN outlets ou ON ou.id = o.outlet_id
		   LEFT JOIN app_settings a ON a.id = 1
		   LEFT JOIN customers c ON c.id = o.customer_id
		  WHERE o.id = $1::uuid`, orderID).
		Scan(&brand, &d.OutletName, &d.OrderNumber, &d.CreatedAt, &d.Zone,
			&d.Subtotal, &d.Discount, &d.Tax, &d.Total, &d.Surcharge, &d.PointsRedeemed,
			&method, &pm, &customer, &d.SalesmanName, &d.LogoURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return d, ErrNotFound
	}
	if err != nil {
		return d, fmt.Errorf("receipt page: %w", err)
	}
	d.Brand = brand
	d.CustomerFirstName, _, _ = strings.Cut(strings.Join(strings.Fields(customer), " "), " ")

	rows, err := r.Pool.Query(ctx,
		`SELECT product_name, variant_size, quantity, subtotal::float8
		   FROM order_items WHERE order_id = $1::uuid ORDER BY line_no NULLS LAST, id`, orderID)
	if err != nil {
		return d, fmt.Errorf("receipt page lines: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var l ReceiptLine
		if err := rows.Scan(&l.Name, &l.Variant, &l.Qty, &l.Subtotal); err != nil {
			return d, fmt.Errorf("receipt page lines: %w", err)
		}
		d.Lines = append(d.Lines, l)
	}
	if err := rows.Err(); err != nil {
		return d, err
	}
	rows.Close()

	methods, err := r.receiptTenderMethods(ctx, orderID, method)
	if err != nil {
		return d, err
	}
	d.Payment = paymentLabels(methods, pm)
	return d, nil
}

// receiptTenderMethods lists the payment methods of an order, one per tender line (the order's own
// method when it has no tender rows).
func (r *Repo) receiptTenderMethods(ctx context.Context, orderID, fallback string) ([]string, error) {
	rows, err := r.Pool.Query(ctx, `SELECT method FROM order_tenders WHERE order_id = $1::uuid ORDER BY seq`, orderID)
	if err != nil {
		return nil, fmt.Errorf("receipt page tenders: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, fmt.Errorf("receipt page tenders: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 && fallback != "" {
		out = []string{fallback}
	}
	return out, nil
}

// paymentLabels maps method ids to the labels configured in app_settings.payment_methods, joined
// with " + " and de-duplicated; an unconfigured id shows as is.
func paymentLabels(methods []string, configured []byte) string {
	var cfg []struct {
		ID    string `json:"id"`
		Label string `json:"label"`
	}
	_ = json.Unmarshal(configured, &cfg)
	label := make(map[string]string, len(cfg))
	for _, c := range cfg {
		label[c.ID] = c.Label
	}
	seen := map[string]bool{}
	var parts []string
	for _, m := range methods {
		l := m
		if v := strings.TrimSpace(label[m]); v != "" {
			l = v
		}
		if !seen[l] {
			seen[l] = true
			parts = append(parts, l)
		}
	}
	return strings.Join(parts, " + ")
}

// WaReceiptTemplate returns the stored WhatsApp template, "" when none is set (the default applies).
func (r *Repo) WaReceiptTemplate(ctx context.Context) (string, error) {
	var tpl *string
	err := r.Pool.QueryRow(ctx, `SELECT wa_receipt_template FROM app_settings WHERE id = 1`).Scan(&tpl)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && tpl == nil) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("wa receipt template: %w", err)
	}
	return *tpl, nil
}
