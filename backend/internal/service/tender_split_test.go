package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type goldenLine struct {
	Seq       int     `json:"seq"`
	Method    string  `json:"method"`
	Amount    float64 `json:"amount"`
	Tendered  float64 `json:"tendered"`
	Change    float64 `json:"change"`
	Reference string  `json:"reference"`
}

type goldenExpected struct {
	PaymentMethod string       `json:"paymentMethod"`
	AmountPaid    float64      `json:"amountPaid"`
	Change        float64      `json:"change"`
	Reason        string       `json:"reason"`
	Lines         []goldenLine `json:"lines"`
}

type goldenAlloc struct {
	Name  string  `json:"name"`
	Mode  string  `json:"mode"`
	Due   float64 `json:"due"`
	Lines []struct {
		Method    string  `json:"method"`
		Amount    float64 `json:"amount"`
		Reference string  `json:"reference"`
	} `json:"lines"`
	Reject   bool            `json:"reject"`
	Expected *goldenExpected `json:"expected"`
}

type goldenStructural struct {
	Name          string          `json:"name"`
	PaymentMethod string          `json:"paymentMethod"`
	Tenders       json.RawMessage `json:"tenders"`
	Reject        bool            `json:"reject"`
}

type tenderGolden struct {
	Allocations []goldenAlloc      `json:"allocations"`
	Structural  []goldenStructural `json:"structural"`
}

func loadTenderGolden(t *testing.T) tenderGolden {
	t.Helper()
	raw, err := os.ReadFile("testdata/tender_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g tenderGolden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Allocations) == 0 || len(g.Structural) == 0 {
		t.Fatal("golden file is empty")
	}
	return g
}

func defaultIsCash(id string) bool {
	switch strings.ToLower(strings.TrimSpace(id)) {
	case "cash", "tunai":
		return true
	}
	return false
}

func (c goldenAlloc) inputs() []TenderLine {
	out := make([]TenderLine, len(c.Lines))
	for i, l := range c.Lines {
		out[i] = TenderLine{Method: l.Method, Amount: l.Amount, Reference: l.Reference}
	}
	return out
}

func (c goldenAlloc) tenderMode() tenderMode {
	if c.Mode == "batch" {
		return tenderBatch
	}
	return tenderOnline
}

func near(a, b float64) bool { return math.Abs(a-b) < 0.0051 }

func TestTenderGoldenAllocations(t *testing.T) {
	for _, c := range loadTenderGolden(t).Allocations {
		t.Run(c.Name, func(t *testing.T) {
			got, err := settleTenders(c.Due, c.inputs(), defaultIsCash, c.tenderMode())
			if c.Reject {
				if !errors.Is(err, ErrTenderRejected) {
					t.Fatalf("want ErrTenderRejected, got %v (%+v)", err, got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			e := c.Expected
			if got.PaymentMethod != e.PaymentMethod || !near(got.AmountPaid, e.AmountPaid) || !near(got.Change, e.Change) || got.Reason != e.Reason {
				t.Fatalf("summary = %+v, want %+v", got, *e)
			}
			if len(got.Rows) != len(e.Lines) {
				t.Fatalf("rows = %+v, want %+v", got.Rows, e.Lines)
			}
			var applied float64
			for i, r := range got.Rows {
				w := e.Lines[i]
				if r.Seq != w.Seq || r.Method != w.Method || !near(r.Amount, w.Amount) || !near(r.Tendered, w.Tendered) || !near(r.Change, w.Change) || r.Reference != w.Reference {
					t.Fatalf("row %d = %+v, want %+v", i, r, w)
				}
				applied += r.Amount
			}
			if !near(applied, c.Due) {
				t.Fatalf("Σ applied = %v, want due %v", applied, c.Due)
			}
		})
	}
}

// One-line parity: the adapter equals evaluateTender plus the legacy decode.
func TestTenderGoldenSingleLineParity(t *testing.T) {
	n := 0
	for _, c := range loadTenderGolden(t).Allocations {
		if len(c.Lines) != 1 {
			continue
		}
		n++
		t.Run(c.Name, func(t *testing.T) {
			l := c.inputs()[0]
			paid, change, reason := evaluateTender(defaultIsCash(l.Method), l.Amount, c.Due)
			got, err := settleTenders(c.Due, c.inputs(), defaultIsCash, c.tenderMode())
			if reason == TenderCashShort && c.tenderMode() == tenderOnline {
				if !errors.Is(err, ErrTenderRejected) {
					t.Fatalf("want reject, got %v", err)
				}
				return
			}
			if err != nil || got.AmountPaid != paid || got.Change != change || got.Reason != reason || got.PaymentMethod != l.Method ||
				len(got.Rows) != 1 || got.Rows[0].Amount != c.Due || got.Rows[0].Tendered != paid || got.Rows[0].Change != change {
				t.Fatalf("adapter %+v err=%v != legacy paid=%v change=%v reason=%q", got, err, paid, change, reason)
			}
		})
	}
	if n == 0 {
		t.Fatal("no single-line golden cases")
	}
}

func TestTenderGoldenStructural(t *testing.T) {
	for _, c := range loadTenderGolden(t).Structural {
		t.Run(c.Name, func(t *testing.T) {
			in := ordinaryInput()
			in.PaymentMethod, in.Tenders = c.PaymentMethod, c.Tenders
			err := ValidateSaleInput(in)
			if c.Reject != (err != nil) {
				t.Fatalf("reject=%v got err=%v", c.Reject, err)
			}
			if err != nil && !errors.Is(err, ErrSaleInput) {
				t.Fatalf("must be the structural sale-input error, got %v", err)
			}
		})
	}
}

func TestTenderReasonPriority(t *testing.T) {
	cases := []struct {
		in   []string
		want string
	}{
		{[]string{TenderCashMerged, TenderNoncashOverpay, TenderShort}, TenderShort},
		{[]string{TenderCashMerged, TenderNoncashOverpay}, TenderNoncashOverpay},
		{[]string{"", TenderCashMerged}, TenderCashMerged},
		{[]string{"", ""}, ""},
	}
	for _, c := range cases {
		if got := tenderReasonPriority(c.in...); got != c.want {
			t.Errorf("%v = %q, want %q", c.in, got, c.want)
		}
	}
}

// Merge flag is lowest: a merged batch sale that is also short reports tender_short.
func TestTenderMergedAndShortReportsShort(t *testing.T) {
	lines := []TenderLine{{Method: "qris", Amount: 50000}, {Method: "tunai", Amount: 10000}, {Method: "cash", Amount: 10000}}
	got, err := allocateTenders(100000, lines, defaultIsCash, tenderBatch)
	if err != nil || got.Reason != TenderShort {
		t.Fatalf("got %+v err=%v", got, err)
	}
}

func TestSettleSaleLegacyAndTenders(t *testing.T) {
	in := ordinaryInput()
	got, err := settleSale(in, 100000, defaultIsCash)
	if err != nil || got.PaymentMethod != "cash" || len(got.Rows) != 1 || got.Rows[0].Tendered != 100000 {
		t.Fatalf("legacy: %+v err=%v", got, err)
	}
	in.Tenders = json.RawMessage(`[{"method":"qris","amount":40000},{"method":"tunai","amount":70000}]`)
	in.PaymentMethod, in.AmountPaid = "ignored", 1
	got, err = settleSale(in, 100000, defaultIsCash)
	if err != nil || got.PaymentMethod != "split" || got.AmountPaid != 110000 || got.Change != 10000 {
		t.Fatalf("tenders: %+v err=%v", got, err)
	}
}

// tenderRecordingTx records the order_tenders INSERT args on top of the shared fake.
type tenderRecordingTx struct {
	*inputTestTx
	tenderRows [][]any
}

func (tx *tenderRecordingTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if strings.Contains(sql, "INSERT INTO order_tenders") {
		tx.tenderRows = append(tx.tenderRows, append([]any(nil), args...))
	}
	return tx.inputTestTx.Exec(ctx, sql, args...)
}

func createWithTenders(t *testing.T, mutate func(*CreateOrderInput)) (*tenderRecordingTx, error) {
	t.Helper()
	in := ordinaryInput() // one 100000 line, no tax
	mutate(&in)
	tx := &tenderRecordingTx{inputTestTx: &inputTestTx{allowWrites: true, stock: 5}}
	_, _, _, err := (&OrderService{}).createOrder(context.Background(), in, func(context.Context) (pgx.Tx, error) { return tx, nil })
	return tx, err
}

func TestSalePathWritesTenderRows(t *testing.T) {
	split := json.RawMessage(`[{"method":"qris","amount":40000,"reference":"R1"},{"method":"tunai","amount":70000}]`)
	t.Run("split sale writes lines and summary columns", func(t *testing.T) {
		tx, err := createWithTenders(t, func(in *CreateOrderInput) { in.Tenders, in.Offline = split, true })
		if err != nil || len(tx.tenderRows) != 2 {
			t.Fatalf("err=%v rows=%v", err, tx.tenderRows)
		}
		a := tx.orderArgs
		if a[21] != "split" || a[22].(float64) != 110000 || a[23].(float64) != 10000 || a[37] != false {
			t.Fatalf("summary args = %v", a[21:24])
		}
		if r := tx.tenderRows[1]; r[1] != 2 || r[2] != "tunai" || r[3].(float64) != 60000 || r[4].(float64) != 70000 || r[5].(float64) != 10000 {
			t.Fatalf("cash row = %v", r)
		}
	})
	t.Run("legacy scalar writes exactly one row", func(t *testing.T) {
		tx, err := createWithTenders(t, func(in *CreateOrderInput) {})
		if err != nil || len(tx.tenderRows) != 1 || tx.tenderRows[0][3].(float64) != 100000 || tx.orderArgs[21] != "cash" {
			t.Fatalf("err=%v rows=%v", err, tx.tenderRows)
		}
	})
	t.Run("online split shortfall is rejected before effects", func(t *testing.T) {
		short := json.RawMessage(`[{"method":"qris","amount":40000},{"method":"tunai","amount":10000}]`)
		tx, err := createWithTenders(t, func(in *CreateOrderInput) { in.Tenders = short })
		if !errors.Is(err, ErrTenderRejected) || tx.writes != 0 || len(tx.tenderRows) != 0 {
			t.Fatalf("err=%v writes=%d rows=%v", err, tx.writes, tx.tenderRows)
		}
	})
	t.Run("batch split shortfall is accepted and flagged", func(t *testing.T) {
		short := json.RawMessage(`[{"method":"qris","amount":40000},{"method":"tunai","amount":10000}]`)
		tx, err := createWithTenders(t, func(in *CreateOrderInput) { in.Tenders, in.Offline = short, true })
		if err != nil || tx.orderArgs[37] != true || tx.orderArgs[38] != any(TenderShort) {
			t.Fatalf("err=%v args=%v", err, tx.orderArgs)
		}
	})
	t.Run("structural reject writes nothing", func(t *testing.T) {
		tx, err := createWithTenders(t, func(in *CreateOrderInput) { in.Tenders, in.Offline = json.RawMessage(`[]`), true })
		if !errors.Is(err, ErrSaleInput) || tx.writes != 0 {
			t.Fatalf("err=%v writes=%d", err, tx.writes)
		}
	})
}
