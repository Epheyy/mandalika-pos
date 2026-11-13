package ledger

import (
	"fmt"
	"sort"
)

// Bucket is a column of the Pergerakan (movement summary) table: the auditor's per-type split of
// the single in/out pair. It is derived from the ledger, never stored. BucketOf is the ONE place
// that maps a ledger row to a bucket; the summary read, the CSV export and the auditor note all
// follow it (see docs/plans/2026-10-27-pergerakan-buckets-catatan-auditor.md).
type Bucket string

const (
	// BucketMasuk is stock arriving from outside the store network of the location: goods receipts
	// (supplier and warranty replacements, "Garansi") and warehouse deliveries received at an outlet.
	BucketMasuk Bucket = "masuk"
	// BucketPenjualan is sales.
	BucketPenjualan Bucket = "penjualan"
	// BucketRefund is customer refunds restocked.
	BucketRefund Bucket = "refund"
	// BucketTransfer is movement between locations other than a warehouse delivery to an outlet:
	// store to store, store to warehouse (returns), and everything sent out of a location.
	BucketTransfer Bucket = "transfer"
	// BucketPenyesuaian is manual adjustments, stock count variances, write-offs and opening
	// balances posted inside the window.
	BucketPenyesuaian Bucket = "penyesuaian"
	// BucketHadiah is the per-sale giveaway item.
	BucketHadiah Bucket = "hadiah"
)

// AllBuckets lists the buckets in column order.
func AllBuckets() []Bucket {
	return []Bucket{BucketMasuk, BucketPenjualan, BucketRefund, BucketTransfer, BucketPenyesuaian, BucketHadiah}
}

// AllKinds lists every valid ledger kind, sorted.
func AllKinds() []Kind {
	out := make([]Kind, 0, len(validKinds))
	for k := range validKinds {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// BucketInput is what the bucket of one ledger row depends on.
type BucketInput struct {
	Kind         Kind
	Giveaway     bool         // dedupe key giveaway:<order id>
	LocationType LocationType // the location the row belongs to
	// TransferSourceIsWarehouse is true when the row's transfer was sent from a warehouse; only
	// read for KindTransferIn.
	TransferSourceIsWarehouse bool
}

// BucketOf returns the bucket of a ledger row, or an error for a kind it does not know (a new kind
// must be mapped here on purpose, never silently dropped from the summary).
func BucketOf(in BucketInput) (Bucket, error) {
	if !validKinds[in.Kind] {
		return "", fmt.Errorf("bucket: unknown ledger kind %q", in.Kind)
	}
	if in.Giveaway {
		return BucketHadiah, nil
	}
	switch in.Kind {
	case KindSale:
		return BucketPenjualan, nil
	case KindRefund, KindVoid:
		return BucketRefund, nil
	case KindReceipt:
		return BucketMasuk, nil
	case KindTransferIn:
		if in.LocationType == LocOutlet && in.TransferSourceIsWarehouse {
			return BucketMasuk, nil
		}
		return BucketTransfer, nil
	case KindTransferOut, KindTransferCancel:
		return BucketTransfer, nil
	case KindAdjust, KindCount, KindWriteOff, KindOpening:
		return BucketPenyesuaian, nil
	}
	return "", fmt.Errorf("bucket: ledger kind %q has no bucket", in.Kind)
}
