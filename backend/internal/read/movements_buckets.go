package read

import (
	"fmt"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/ledger"
)

// summaryGroup is the signed-apart quantity of one SKU's ledger rows that share the signals a
// bucket depends on (kind, giveaway, receipt source, transfer source). SQL groups; ledger.BucketOf
// decides, so the kind-to-bucket mapping exists in exactly one place.
type summaryGroup struct {
	Kind     string `json:"kind"`
	Giveaway bool   `json:"giveaway"`
	Warranty bool   `json:"warranty"`
	SrcWh    bool   `json:"srcWh"`
	QtyIn    int    `json:"qin"`
	QtyOut   int    `json:"qout"`
}

// summaryRowRaw is a summary row as the query builds it: the API row plus its groups.
type summaryRowRaw struct {
	api.MovementLedgerSummaryRow
	Groups []summaryGroup `json:"groups"`
}

// foldGroups turns a SKU's groups into the bucket totals (signed), the warranty part of Masuk and
// the per-kind in/out maps. Every group lands in exactly one bucket, so the buckets always sum to
// the net movement of the range: opening + buckets = closing.
func foldGroups(loc ledger.LocationType, groups []summaryGroup) (b api.MovementBuckets, garansi int, in, out map[string]int, err error) {
	in, out = map[string]int{}, map[string]int{}
	for _, g := range groups {
		bucket, err := ledger.BucketOf(ledger.BucketInput{
			Kind: ledger.Kind(g.Kind), Giveaway: g.Giveaway, LocationType: loc, TransferSourceIsWarehouse: g.SrcWh,
		})
		if err != nil {
			return b, 0, nil, nil, fmt.Errorf("fold movement summary: %w", err)
		}
		net := g.QtyIn - g.QtyOut
		switch bucket {
		case ledger.BucketMasuk:
			b.Masuk += net
			if g.Warranty {
				garansi += net
			}
		case ledger.BucketPenjualan:
			b.Penjualan += net
		case ledger.BucketRefund:
			b.Refund += net
		case ledger.BucketTransfer:
			b.Transfer += net
		case ledger.BucketPenyesuaian:
			b.Penyesuaian += net
		case ledger.BucketHadiah:
			b.Hadiah += net
		default:
			return b, 0, nil, nil, fmt.Errorf("fold movement summary: bucket %q has no column", bucket)
		}
		if g.QtyIn > 0 {
			in[g.Kind] += g.QtyIn
		}
		if g.QtyOut > 0 {
			out[g.Kind] += g.QtyOut
		}
	}
	return b, garansi, in, out, nil
}
