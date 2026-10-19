package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type inputTestRow func(...any) error

func (r inputTestRow) Scan(dest ...any) error { return r(dest...) }

// This fake runs the real CreateOrder body through its first write boundary.
// It records attempted SQL effects, not PostgreSQL balances or durability.
type inputTestTx struct {
	pgx.Tx
	writes         int
	commits        int
	queries        []string
	existing       string
	allowWrites    bool
	stock          int
	taxRate        float64
	paymentMethods []byte
	orderArgs      []any
	key            string
	noVariant      bool    // stock SELECT returns ErrNoRows (deleted/renamed variant)
	exceptions     [][]any // args of each INSERT INTO sale_stock_exceptions
}

func (tx *inputTestTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	tx.queries = append(tx.queries, sql)
	return inputTestRow(func(d ...any) error {
		switch {
		case strings.Contains(sql, "FROM processed_keys"):
			tx.key = args[0].(string)
			if tx.existing != "" {
				*d[0].(*string) = tx.existing
				return nil
			}
			return pgx.ErrNoRows
		case strings.Contains(sql, "FROM app_settings"):
			*d[0].(*bool) = tx.taxRate != 0
			*d[1].(*float64) = tx.taxRate
			*d[2].(*bool) = false
			*d[3].(*string) = "none"
			if len(d) > 4 {
				*d[4].(*[]byte) = tx.paymentMethods
			}
			return nil
		case strings.Contains(sql, "FROM outlets"):
			return pgx.ErrNoRows // outletZone: unknown outlet = Asia/Jakarta
		case strings.Contains(sql, "FROM loyalty_settings"):
			*d[0].(*bool) = false
			*d[1].(*float64) = 0
			*d[2].(*float64) = 0
			return nil
		case strings.Contains(sql, "SELECT stock FROM outlet_variant_stock"):
			if tx.noVariant {
				return pgx.ErrNoRows
			}
			*d[0].(*int) = tx.stock
			return nil
		case strings.Contains(sql, "nextval('order_no_seq')"):
			*d[0].(*int64) = 1
			return nil
		case strings.Contains(sql, "INSERT INTO orders"):
			tx.writes++
			tx.orderArgs = append([]any(nil), args...)
			*d[0].(*string) = "accepted-original"
			return nil
		default:
			return errors.New("unexpected synthetic read")
		}
	})
}
func (tx *inputTestTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.writes++
	if tx.allowWrites {
		if strings.Contains(sql, "UPDATE outlet_variant_stock") {
			tx.stock = args[0].(int)
		}
		if strings.Contains(sql, "INSERT INTO sale_stock_exceptions") {
			tx.exceptions = append(tx.exceptions, append([]any(nil), args...))
		}
		if strings.Contains(sql, "INSERT INTO processed_keys") {
			tx.key = args[0].(string)
			tx.existing = args[1].(string)
		}
		return pgconn.NewCommandTag("OK"), nil
	}
	return pgconn.CommandTag{}, errors.New("synthetic stop at first stock write")
}

func TestSaleInputDomainsBeforeEffects(t *testing.T) {
	cases := []struct {
		name   string
		change func(*CreateOrderInput)
	}{
		{"quantity int4 overflow", func(in *CreateOrderInput) { in.Items[0].Quantity = math.MaxInt32 + 1 }},
		{"negative price", func(in *CreateOrderInput) { in.Items[0].Price = -1 }},
		{"negative subtotal", func(in *CreateOrderInput) { in.Items[0].Subtotal = -1 }},
		{"line mismatch", func(in *CreateOrderInput) { in.Items[0].Subtotal = 99999 }},
		{"price overflow", func(in *CreateOrderInput) { in.Items[0].Price = maxSaleMoney + 1 }},
		{"subtotal overflow", func(in *CreateOrderInput) { in.Items[0].Subtotal = maxSaleMoney + 1 }},
		{"product overflow", func(in *CreateOrderInput) {
			in.Items[0].Price = maxSaleMoney
			in.Items[0].Quantity = 2
			in.Items[0].Subtotal = maxSaleMoney
		}},
		{"sum overflow", func(in *CreateOrderInput) {
			in.Items[0].Price = maxSaleMoney
			in.Items[0].Subtotal = maxSaleMoney
			in.Items = append(in.Items, in.Items[0])
		}},
		{"negative tender", func(in *CreateOrderInput) { in.AmountPaid = -1 }},
		{"tender overflow", func(in *CreateOrderInput) { in.AmountPaid = maxSaleMoney + 1 }},
		{"negative discount", func(in *CreateOrderInput) { in.ManualValue = -1 }},
		{"negative surcharge", func(in *CreateOrderInput) { in.Surcharge = -1 }},
		{"negative points", func(in *CreateOrderInput) { in.PointsRedeemed = -1 }},
		{"points int4 overflow", func(in *CreateOrderInput) { in.PointsRedeemed = math.MaxInt32 + 1 }},
		{"empty method", func(in *CreateOrderInput) { in.PaymentMethod = " \t" }},
		{"NaN price", func(in *CreateOrderInput) { in.Items[0].Price = math.NaN() }},
		{"Inf subtotal", func(in *CreateOrderInput) { in.Items[0].Subtotal = math.Inf(1) }},
		{"NaN tender", func(in *CreateOrderInput) { in.AmountPaid = math.NaN() }},
		{"Inf discount", func(in *CreateOrderInput) { in.ManualValue = math.Inf(1) }},
		{"Inf surcharge", func(in *CreateOrderInput) { in.Surcharge = math.Inf(-1) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, flagged := range []bool{false, true} {
				in := ordinaryInput()
				tc.change(&in)
				in.Offline = flagged
				in.Items[0].IsReward = flagged
				in.Items[0].IsBundle = flagged
				tx := &inputTestTx{}
				_, dup, _, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
				if !errors.Is(err, ErrSaleInput) || dup || tx.writes != 0 || tx.commits != 0 || len(tx.queries) != 1 {
					t.Fatalf("flagged=%v err=%v tx=%+v", flagged, err, tx)
				}
			}
		})
	}
}

func TestSaleInputWireRepresentation(t *testing.T) {
	for _, raw := range []string{
		`{"price":0,"quantity":1.5,"subtotal":0}`, `{"price":0,"quantity":"1","subtotal":0}`,
		`{"price":0,"quantity":9223372036854775808,"subtotal":0}`, `{"price":0,"quantity":null,"subtotal":0}`,
		`{"quantity":1,"subtotal":0}`, `{"price":null,"quantity":1,"subtotal":0}`,
		`{"price":0,"quantity":1}`, `{"price":0,"quantity":1,"subtotal":null}`, `null`,
		`{"price":1e999,"quantity":1,"subtotal":0}`, `{"price":"0","quantity":1,"subtotal":0}`,
	} {
		var item OrderItem
		if err := json.Unmarshal([]byte(raw), &item); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	var item OrderItem
	if err := json.Unmarshal([]byte(`{"price":0,"quantity":1,"subtotal":0,"isReward":true,"futureField":"legacy tolerated"}`), &item); err != nil {
		t.Fatal(err)
	}
}

func TestSaleInputSupportedShapes(t *testing.T) {
	cases := []struct {
		name   string
		change func(*CreateOrderInput)
	}{
		{"ordinary cash", func(in *CreateOrderInput) {}},
		{"configured noncash legacy missing tender", func(in *CreateOrderInput) { in.PaymentMethod = "neo_bank"; in.AmountPaid = 0 }},
		{"guest free", func(in *CreateOrderInput) { in.Items[0].Price = 0; in.Items[0].Subtotal = 0; in.AmountPaid = 0 }},
		{"loyalty free line", func(in *CreateOrderInput) {
			in.Items[0].Price = 0
			in.Items[0].Subtotal = 0
			in.Items[0].IsReward = true
			in.Items[0].RewardConditionID = "condition"
			in.AmountPaid = 0
		}},
		{"fully discounted", func(in *CreateOrderInput) { in.ManualKind = DiscountFixed; in.ManualValue = 100000; in.AmountPaid = 0 }},
		{"static bundle SKU", func(in *CreateOrderInput) { in.Items[0].IsBundle = true }},
		{"BXGY fractional net", func(in *CreateOrderInput) {
			in.Items[0].IsReward = true
			in.Items[0].Price = 333.3333
			in.Items[0].Quantity = 3
			in.Items[0].Subtotal = 999.9999
		}},
		{"rounded bundle freed line", func(in *CreateOrderInput) {
			in.Items[0].IsReward = true
			in.Items[0].Price = 333.3333
			in.Items[0].Quantity = 3
			in.Items[0].Subtotal = 1000
		}},
		{"decimal price", func(in *CreateOrderInput) {
			in.Items[0].Price = 10.25
			in.Items[0].Quantity = 3
			in.Items[0].Subtotal = 30.75
		}},
		{"schema quantity upper bound free", func(in *CreateOrderInput) {
			in.Items[0].Price = 0
			in.Items[0].Quantity = math.MaxInt32
			in.Items[0].Subtotal = 0
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := ordinaryInput()
			tc.change(&in)
			if err := ValidateSaleInput(in); err != nil {
				t.Fatal(err)
			}
		})
	}
	// Server allocation 1000/3 has rounded unit price 333 but subtotal 1000.
	resolved := []OrderItem{{Price: 333, Quantity: 3, Subtotal: 1000}}
	if err := validateSaleItems(resolved, false); err != nil {
		t.Fatal(err)
	}
	if err := validateSaleItems(resolved, true); err == nil {
		t.Fatal("unexplained captured mismatch accepted")
	}
}

func TestSaleInputDerivedArithmeticBeforeEffects(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		price, surcharge, tax float64
	}{
		{"sum plus surcharge", maxSaleMoney - 1, 2, 0},
		{"tax overflow", maxSaleMoney / 2, 0, 200},
		{"tax nonfinite", 100000, 0, math.Inf(1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := ordinaryInput()
			in.Items[0].Price = tc.price
			in.Items[0].Subtotal = tc.price
			in.Surcharge = tc.surcharge
			in.SurchargeKind = DiscountFixed
			tx := &inputTestTx{taxRate: tc.tax}
			_, _, _, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
			if !errors.Is(err, ErrSaleInput) || tx.writes != 0 || tx.commits != 0 {
				t.Fatalf("err=%v tx=%+v", err, tx)
			}
		})
	}
	if err := validateSalePricing(PricingResult{ManualDiscount: math.Inf(1)}); err == nil {
		t.Fatal("hidden nonfinite discount accepted")
	}
	if err := salePoints("points", float64(math.MaxInt32)+1); err == nil {
		t.Fatal("points overflow accepted")
	}
}

func TestSaleInputPreservesKnownReceiptAndQ08Shortage(t *testing.T) {
	for _, offline := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct negative", true: "batch warning"}[offline], func(t *testing.T) {
			in := ordinaryInput()
			in.Offline = offline
			// Current tax raises the total to 110000; tender covers it (A09), so this
			// keeps exercising the stock floor/warning, not the tender rule.
			in.AmountPaid = 110000
			original := append([]OrderItem(nil), in.Items...)
			tx := &inputTestTx{allowWrites: true, stock: 0, taxRate: 10}
			begin := func(context.Context) (pgx.Tx, error) { return tx, nil }
			id, dup, warn, err := (&OrderService{}).createOrder(context.Background(), in, begin)
			// A44 owner decision 2026-10-14 (never block a sale, record the true
			// negative): the direct path no longer floors at 0, and both paths flag
			// the shortage. This replaces the old "direct floor" expectation (0 / no warn).
			wantStock := -1
			if err != nil || dup || id != "accepted-original" || !warn || tx.commits != 1 || tx.stock != wantStock {
				t.Fatalf("id=%s dup=%v warn=%v err=%v tx=%+v", id, dup, warn, err, tx)
			}
			// Current tax raises total; capture is kept and tender is not flagged.
			if tx.orderArgs[20].(float64) != 110000 || tx.orderArgs[22].(float64) != 110000 || tx.orderArgs[36] != false {
				t.Fatalf("capture/total: %v", tx.orderArgs)
			}
			if !reflect.DeepEqual(in.Items, original) {
				t.Fatal("caller capture mutated")
			}
			writes := tx.writes
			// A simulated lost response: retry the SAME key, then changed malformed input.
			for _, qty := range []int{1, -1} {
				in.Items[0].Quantity = qty
				id, dup, _, err = (&OrderService{}).createOrder(context.Background(), in, begin)
				if err != nil || !dup || id != "accepted-original" || tx.key != "original-key" || tx.writes != writes || tx.commits != 1 {
					t.Fatalf("replay=%s %v %v tx=%+v", id, dup, err, tx)
				}
			}
		})
	}
}

// A09: the same raised total with cash captured at 100000 is a cash shortfall.
func TestTenderShortfallBeforeEffects(t *testing.T) {
	for _, offline := range []bool{false, true} {
		t.Run(map[bool]string{false: "direct rejected", true: "batch flagged"}[offline], func(t *testing.T) {
			in := ordinaryInput() // cash 100000 vs 110000 after tax
			in.Offline = offline
			tx := &inputTestTx{allowWrites: true, stock: 0, taxRate: 10}
			begin := func(context.Context) (pgx.Tx, error) { return tx, nil }
			id, _, _, err := (&OrderService{}).createOrder(context.Background(), in, begin)
			if !offline {
				if !errors.Is(err, ErrTenderRejected) || tx.writes != 0 || tx.commits != 0 || tx.stock != 0 {
					t.Fatalf("direct shortfall must reject before effects: id=%s err=%v tx=%+v", id, err, tx)
				}
				return
			}
			if err != nil || tx.commits != 1 || tx.orderArgs[22].(float64) != 100000 || tx.orderArgs[36] != true || tx.orderArgs[37] != any(TenderCashShort) {
				t.Fatalf("batch must accept and flag: err=%v args=%v", err, tx.orderArgs)
			}
		})
	}
}

// Slice 8c: the live cash method id is "tunai"; the configured flag decides.
func TestTenderCashIdentityFromSettings(t *testing.T) {
	for _, tc := range []struct {
		name, method, methods string
		wantReject            bool
	}{
		{"tunai is cash by default", "tunai", ``, true},
		{"TUNAI is cash by default", "TUNAI", ``, true},
		{"explicit isCash=false makes tunai non-cash", "tunai", `[{"id":"tunai","label":"T","isEnabled":true,"isCash":false}]`, false},
		{"explicit isCash=true makes a custom id cash", "kas_kecil", `[{"id":"kas_kecil","label":"K","isEnabled":true,"isCash":true}]`, true},
		{"unflagged custom id is non-cash", "bca", ``, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := ordinaryInput() // 100000 line, no tax
			in.PaymentMethod, in.AmountPaid = tc.method, 90000
			tx := &inputTestTx{allowWrites: true, stock: 5, paymentMethods: []byte(tc.methods)}
			_, _, _, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
			if tc.wantReject {
				if !errors.Is(err, ErrTenderRejected) || tx.writes != 0 {
					t.Fatalf("want 422 before effects: err=%v tx=%+v", err, tx)
				}
				return
			}
			if err != nil || tx.orderArgs[36] != true || tx.orderArgs[37] != any(TenderNoncashMismatch) {
				t.Fatalf("want accepted + mismatch flag: err=%v args=%v", err, tx.orderArgs)
			}
		})
	}
}

func (tx *inputTestTx) Rollback(context.Context) error { return nil }
func (tx *inputTestTx) Commit(context.Context) error   { tx.commits++; return nil }

func ordinaryInput() CreateOrderInput {
	return CreateOrderInput{OutletID: "synthetic-outlet", IdempotencyKey: "original-key", PaymentMethod: "cash", AmountPaid: 100000,
		Items: []OrderItem{{ProductID: "synthetic-product", ProductName: "Synthetic", VariantSize: "110ml", Price: 100000, Quantity: 1, Subtotal: 100000}}}
}

func TestSaleInputNegativeAndZeroQuantityRegression(t *testing.T) {
	for _, qty := range []int{-1, 0} {
		for _, offline := range []bool{false, true} {
			in := ordinaryInput()
			in.Items[0].Quantity = qty
			in.Offline = offline
			tx := &inputTestTx{}
			_, dup, _, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
			if err == nil || dup || tx.writes != 0 || tx.commits != 0 {
				t.Errorf("quantity=%d offline=%v must reject before effects: err=%v dup=%v writes=%d commits=%d", qty, offline, err, dup, tx.writes, tx.commits)
			}
		}
	}
}

// A44: the sale records a per-line exception for every shortfall and no longer
// floors stock at zero on the direct path. Args order of the exception insert is
// defined by write.InsertSaleStockException (see the arg-index constants below).
const (
	excArgKind        = 7
	excArgQuantity    = 8
	excArgStockBefore = 9
	excArgStockAfter  = 10
	excArgShortfall   = 11
	excArgChannel     = 12
)

func shortageInput(qtys ...int) CreateOrderInput {
	in := ordinaryInput()
	in.Items = nil
	for _, q := range qtys {
		in.Items = append(in.Items, OrderItem{ProductID: "synthetic-product", ProductName: "Synthetic", VariantSize: "110ml",
			Price: 1000, Quantity: q, Subtotal: float64(1000 * q)})
	}
	in.AmountPaid = 1000 * 100
	return in
}

func TestSaleRecordsStockShortageException(t *testing.T) {
	cases := []struct {
		name       string
		stock      int
		qtys       []int
		wantRows   int
		wantBefore []int
		wantAfter  []int
		wantShort  []int
		wantFinal  int
	}{
		{"zero stock sells one", 0, []int{1}, 1, []int{0}, []int{-1}, []int{1}, -1},
		{"partial cover", 1, []int{3}, 1, []int{1}, []int{-2}, []int{2}, -2},
		{"already negative", -2, []int{1}, 1, []int{-2}, []int{-3}, []int{1}, -3},
		{"same sku two lines", 1, []int{1, 1}, 1, []int{0}, []int{-1}, []int{1}, -1},
		{"enough stock", 5, []int{2}, 0, nil, nil, nil, 3},
	}
	for _, tc := range cases {
		for _, offline := range []bool{false, true} {
			t.Run(tc.name+map[bool]string{false: "/direct", true: "/sync"}[offline], func(t *testing.T) {
				in := shortageInput(tc.qtys...)
				in.Offline = offline
				in.ClientCreated = nil
				tx := &inputTestTx{allowWrites: true, stock: tc.stock}
				_, dup, warn, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
				if err != nil || dup || tx.commits != 1 {
					t.Fatalf("err=%v dup=%v tx=%+v", err, dup, tx)
				}
				if warn != (tc.wantRows > 0) || tx.stock != tc.wantFinal || len(tx.exceptions) != tc.wantRows {
					t.Fatalf("warn=%v stock=%d rows=%d", warn, tx.stock, len(tx.exceptions))
				}
				wantChannel := map[bool]string{false: "direct", true: "sync"}[offline]
				for i, row := range tx.exceptions {
					if row[excArgKind] != "shortage" || *row[excArgStockBefore].(*int) != tc.wantBefore[i] ||
						*row[excArgStockAfter].(*int) != tc.wantAfter[i] || row[excArgShortfall] != tc.wantShort[i] ||
						row[excArgChannel] != wantChannel {
						t.Fatalf("row %d = %v", i, row)
					}
				}
			})
		}
	}
}

// A replay of a known key must not attempt any exception insert.
func TestSaleReplayWritesNoStockException(t *testing.T) {
	in := shortageInput(1)
	tx := &inputTestTx{allowWrites: true, stock: 0, existing: "accepted-original"}
	_, dup, _, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
	if err != nil || !dup || len(tx.exceptions) != 0 || tx.writes != 0 {
		t.Fatalf("replay err=%v dup=%v exceptions=%d writes=%d", err, dup, len(tx.exceptions), tx.writes)
	}
}

// A44 phase 4: a line whose variant has no product_variants row moves no stock and
// is recorded as an unresolved_variant exception (not for bundle lines).
func TestSaleRecordsUnresolvedVariantException(t *testing.T) {
	for _, offline := range []bool{false, true} {
		in := shortageInput(2)
		in.Offline = offline
		tx := &inputTestTx{allowWrites: true, stock: 7, noVariant: true}
		_, dup, warn, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
		if err != nil || dup || tx.commits != 1 || tx.stock != 7 || len(tx.exceptions) != 1 || !warn {
			t.Fatalf("offline=%v err=%v dup=%v warn=%v stock=%d rows=%d", offline, err, dup, warn, tx.stock, len(tx.exceptions))
		}
		row := tx.exceptions[0]
		if row[excArgKind] != "unresolved_variant" || row[excArgQuantity] != 2 || row[excArgShortfall] != 2 ||
			row[excArgStockBefore].(*int) != nil || row[excArgStockAfter].(*int) != nil {
			t.Fatalf("row = %v", row)
		}
	}
}

func TestSaleBundleLineWithoutVariantWritesNoException(t *testing.T) {
	in := shortageInput(1)
	in.Items[0].IsBundle = true
	tx := &inputTestTx{allowWrites: true, stock: 7, noVariant: true}
	_, _, warn, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
	if err != nil || len(tx.exceptions) != 0 || warn {
		t.Fatalf("bundle line: err=%v rows=%d warn=%v", err, len(tx.exceptions), warn)
	}
}
