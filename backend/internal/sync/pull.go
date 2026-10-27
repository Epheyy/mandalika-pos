package sync

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/read"
)

type VersionInfo struct {
	Version  int64           `json:"version"`
	Manifest json.RawMessage `json:"dataManifest"`
	// Contact is the signed online-contact proof, set by the handler when the request
	// carried a device id (A05). Absent otherwise (omitempty: old clients unaffected).
	Contact *ContactToken `json:"contact,omitempty"`
	// StockSeq is the outlet's stock change counter (outlet_stock_seq) read in the same
	// statement as Version. A pointer so a real 0 survives omitempty; nil = no signal
	// (kill switch). Never nullable on the wire.
	StockSeq *int64 `json:"stockSeq,omitempty"`
}

// Version returns the outlet content version and stock counter, lazily seeding the row.
// Both are read by ONE statement (one snapshot), so a caller never sees a version from
// one moment and a counter from another.
func (e *Engine) Version(ctx context.Context, outletID string) (VersionInfo, error) {
	var v VersionInfo
	var seq int64
	err := e.Pool.QueryRow(ctx,
		`SELECT version, data_manifest,
		        COALESCE((SELECT seq FROM outlet_stock_seq WHERE outlet_id=$1), 0)
		   FROM content_versions WHERE outlet_id=$1`,
		outletID).Scan(&v.Version, &v.Manifest, &seq)
	if errors.Is(err, pgx.ErrNoRows) {
		_, _ = e.Pool.Exec(ctx,
			`INSERT INTO content_versions (outlet_id) VALUES ($1)
			 ON CONFLICT DO NOTHING`, outletID)
		if err = e.Pool.QueryRow(ctx,
			`SELECT COALESCE((SELECT seq FROM outlet_stock_seq WHERE outlet_id=$1), 0)`,
			outletID).Scan(&seq); err != nil {
			return VersionInfo{}, err
		}
		v = VersionInfo{Version: 1, Manifest: json.RawMessage("{}")}
	} else if err != nil {
		return v, err
	}
	if !e.StockSeqOff {
		v.StockSeq = &seq
	}
	return v, nil
}

// PullBundle is the full reference snapshot POS swaps in on Resync. Sending the
// whole snapshot keeps the swap atomic and conflict-free (POS is read-only on
// reference data — plan §5a).
type PullBundle struct {
	Version int64 `json:"version"`
	// StockSeq is the outlet stock counter as of the moment Version() was read, which
	// is BEFORE the products below are read: the stock in this bundle covers every
	// change up to StockSeq (a change committing in between only causes one extra pull).
	StockSeq       *int64 `json:"stockSeq,omitempty"`
	OutletCode     string `json:"outletCode"`
	OutletName     string `json:"outletName"`
	OutletTimezone string `json:"outletTimezone,omitempty"`
	// OutletGiveaway (C3) is the outlet's enabled per-sale giveaway so the POS can show and count
	// it offline; nil (omitted) = none. The sale path still decides what is taken.
	OutletGiveaway    *read.PullGiveaway `json:"outletGiveaway,omitempty"`
	Products          any                `json:"products"`
	Categories        any                `json:"categories"`
	Bundles           any                `json:"bundles"`
	Customers         any                `json:"customers"`
	Promotions        any                `json:"promotions"`
	DiscountCodes     any                `json:"discountCodes"`
	LoyaltyConditions any                `json:"loyaltyConditions"`
	LoyaltySettings   any                `json:"loyaltySettings"`
	AppSettings       any                `json:"appSettings"`
	Users             any                `json:"users"`
	ReceiveApprovers  any                `json:"receiveApprovers"`
}

func (e *Engine) Pull(ctx context.Context, sc read.Scope, outletID string) (PullBundle, error) {
	var b PullBundle
	// A15 Phase B: Version() MUST stay the FIRST query. The stock counter it returns
	// has to be read before e.Read.Products below, so the bundle's stock is at least as
	// new as its stockSeq; read it later and a pull could claim a sequence number whose
	// stock change it does not contain. Do not cache anything between the two reads
	// (the handler-layer product cache is bypassed here on purpose).
	vi, err := e.Version(ctx, outletID)
	if err != nil {
		return b, err
	}
	b.Version = vi.Version
	b.StockSeq = vi.StockSeq
	// Outlet code → POS so it can build {OUTLET}-{DEV}{SEQ} order numbers offline.
	// Outlet name → POS so the recap/print read the active outlet, not a constant.
	// Outlet timezone -> POS so its promo twin gates hours/dates on the outlet clock (A28).
	var code, name, tz *string
	if e := e.Pool.QueryRow(ctx, `SELECT code, name, timezone FROM outlets WHERE id=$1`, outletID).Scan(&code, &name, &tz); e == nil {
		if tz != nil {
			b.OutletTimezone = *tz
		}
		if code != nil {
			b.OutletCode = *code
		}
		if name != nil {
			b.OutletName = *name
		}
	}
	// A lookup failure must not fail the whole pull (the tablet's lifeline): log and omit, the
	// POS then simply shows no giveaway line until the next pull.
	if g, gerr := read.OutletGiveawayForPull(ctx, e.Pool, outletID); gerr != nil {
		slog.Warn("pull: outlet giveaway lookup failed", "outlet", outletID, "err", gerr)
	} else {
		b.OutletGiveaway = g
	}
	// Outlet-scoped: POS receives this outlet's resolved stock/price, only products
	// available here, and only customer-sellable ones (sc.OutletID = cashier outlet).
	sc.SellableOnly = true
	if b.Products, _, err = e.Read.Products(ctx, sc, 1, 100000); err != nil {
		return b, err
	}
	if b.Categories, _, err = e.Read.Categories(ctx); err != nil {
		return b, err
	}
	if b.Bundles, _, err = e.Read.Bundles(ctx); err != nil {
		return b, err
	}
	// A30: the tablet no longer carries a browsable customer list. The field stays (empty)
	// so an old POS bundle parses; cashiers find customers by exact phone online.
	b.Customers = []api.Customer{}
	if b.Promotions, _, err = e.Read.Promotions(ctx); err != nil {
		return b, err
	}
	codes, _, err := e.Read.DiscountCodes(ctx)
	if err != nil {
		return b, err
	}
	// customerId stays (the POS wrong_customer rule needs it); the name is PII.
	b.DiscountCodes = read.WithoutCustomerNames(codes)
	if b.LoyaltyConditions, _, err = e.Read.LoyaltyConditions(ctx); err != nil {
		return b, err
	}
	if b.LoyaltySettings, err = e.Read.LoyaltySettings(ctx); err != nil {
		return b, err
	}
	if b.AppSettings, err = e.Read.AppSettings(ctx); err != nil {
		return b, err
	}
	// Staff list for the salesman picker (offline-capable; small table).
	if b.Users, _, err = e.Read.Users(ctx, 1, 100000); err != nil {
		return b, err
	}
	// A08: no PIN hash (and no approver list) is shipped to tablets any more. The field
	// stays, always empty, so older bundles still parse; approvers come online from
	// GET /sync/receive-approvers.
	b.ReceiveApprovers = []api.ReceiveApprover{}
	return b, nil
}
