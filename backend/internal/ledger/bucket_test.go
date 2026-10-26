package ledger

import "testing"

// Every kind, in every combination of the extra signals, lands in exactly one known bucket.
func TestBucketOfEveryKindLandsInExactlyOneBucket(t *testing.T) {
	known := map[Bucket]bool{}
	for _, b := range AllBuckets() {
		known[b] = true
	}
	for _, kind := range AllKinds() {
		for _, giveaway := range []bool{false, true} {
			for _, loc := range []LocationType{LocOutlet, LocWarehouse} {
				for _, fromWh := range []bool{false, true} {
					got, err := BucketOf(BucketInput{Kind: kind, Giveaway: giveaway, LocationType: loc, TransferSourceIsWarehouse: fromWh})
					if err != nil {
						t.Fatalf("kind %s giveaway=%v loc=%s fromWh=%v: %v", kind, giveaway, loc, fromWh, err)
					}
					if !known[got] {
						t.Fatalf("kind %s mapped to unknown bucket %q", kind, got)
					}
				}
			}
		}
	}
}

func TestBucketOfUnknownKindIsAnError(t *testing.T) {
	if _, err := BucketOf(BucketInput{Kind: "bogus", LocationType: LocOutlet}); err == nil {
		t.Fatal("an unknown kind must not be silently bucketed")
	}
}

func TestBucketOfMapping(t *testing.T) {
	cases := []struct {
		name string
		in   BucketInput
		want Bucket
	}{
		{"sale", BucketInput{Kind: KindSale, LocationType: LocOutlet}, BucketPenjualan},
		{"refund", BucketInput{Kind: KindRefund, LocationType: LocOutlet}, BucketRefund},
		{"receipt is Masuk (supply and warranty alike)", BucketInput{Kind: KindReceipt, LocationType: LocOutlet}, BucketMasuk},
		{"warehouse delivery received at an outlet is Masuk", BucketInput{Kind: KindTransferIn, LocationType: LocOutlet, TransferSourceIsWarehouse: true}, BucketMasuk},
		{"outlet to outlet received is Transfer", BucketInput{Kind: KindTransferIn, LocationType: LocOutlet}, BucketTransfer},
		{"store return received at the warehouse is Transfer", BucketInput{Kind: KindTransferIn, LocationType: LocWarehouse}, BucketTransfer},
		{"warehouse to warehouse received is Transfer", BucketInput{Kind: KindTransferIn, LocationType: LocWarehouse, TransferSourceIsWarehouse: true}, BucketTransfer},
		{"transfer out of the warehouse is Transfer", BucketInput{Kind: KindTransferOut, LocationType: LocWarehouse}, BucketTransfer},
		{"transfer out of an outlet is Transfer", BucketInput{Kind: KindTransferOut, LocationType: LocOutlet}, BucketTransfer},
		{"cancelled transfer returns to the source: Transfer", BucketInput{Kind: KindTransferCancel, LocationType: LocWarehouse}, BucketTransfer},
		{"adjust", BucketInput{Kind: KindAdjust, LocationType: LocWarehouse}, BucketPenyesuaian},
		{"count variance", BucketInput{Kind: KindCount, LocationType: LocOutlet}, BucketPenyesuaian},
		{"write-off", BucketInput{Kind: KindWriteOff, LocationType: LocOutlet}, BucketPenyesuaian},
		{"opening balance inside the window", BucketInput{Kind: KindOpening, LocationType: LocOutlet}, BucketPenyesuaian},
		{"giveaway sale", BucketInput{Kind: KindSale, Giveaway: true, LocationType: LocOutlet}, BucketHadiah},
		{"giveaway wins over the kind", BucketInput{Kind: KindRefund, Giveaway: true, LocationType: LocOutlet}, BucketHadiah},
	}
	for _, c := range cases {
		got, err := BucketOf(c.in)
		if err != nil || got != c.want {
			t.Errorf("%s: got %q (err %v), want %q", c.name, got, err, c.want)
		}
	}
}

func TestAllKindsMatchesValidKinds(t *testing.T) {
	if len(AllKinds()) != len(validKinds) {
		t.Fatalf("AllKinds has %d kinds, validKinds %d", len(AllKinds()), len(validKinds))
	}
	for _, k := range AllKinds() {
		if !validKinds[k] {
			t.Fatalf("%s is not a valid kind", k)
		}
	}
}
