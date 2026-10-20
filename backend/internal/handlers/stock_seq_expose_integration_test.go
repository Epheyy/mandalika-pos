package handlers

import (
	"encoding/json"
	"strings"
	"testing"
)

const stOutletC = "00000000-0000-4000-8f58-00000000000c"

type stVersionBody struct {
	Data struct {
		Version  int64  `json:"version"`
		StockSeq *int64 `json:"stockSeq"`
	} `json:"data"`
}

type stPullBody struct {
	Data struct {
		Version  int64  `json:"version"`
		StockSeq *int64 `json:"stockSeq"`
		Products []struct {
			ID       string `json:"id"`
			Variants []struct {
				Size  string `json:"size"`
				Stock int    `json:"stock"`
			} `json:"variants"`
		} `json:"products"`
	} `json:"data"`
}

func (f *stFixture) version(t *testing.T) stVersionBody {
	t.Helper()
	code, body := f.do(t, "GET", "/sync/version", nil, "")
	var v stVersionBody
	if code != 200 || json.Unmarshal([]byte(body), &v) != nil {
		t.Fatalf("version %d %s", code, body)
	}
	return v
}

func (f *stFixture) pull(t *testing.T) stPullBody {
	t.Helper()
	code, body := f.do(t, "GET", "/sync/pull", nil, "")
	var p stPullBody
	if code != 200 || json.Unmarshal([]byte(body), &p) != nil {
		t.Fatalf("pull %d %.300s", code, body)
	}
	return p
}

func (f *stFixture) pulledStock(p stPullBody, pid string) (int, bool) {
	for _, pr := range p.Data.Products {
		if pr.ID != pid {
			continue
		}
		for _, v := range pr.Variants {
			if v.Size == stSize {
				return v.Stock, true
			}
		}
	}
	return 0, false
}

func (f *stFixture) runExposeCases(t *testing.T) {
	t.Run("E1 the ack carries the sale's own seq; version, pull and batch carry the outlet's", func(t *testing.T) {
		pid := f.product(t, 10)
		before := f.version(t)
		if before.Data.StockSeq == nil || *before.Data.StockSeq != f.seq(t, stOutletA) {
			t.Fatalf("version stockSeq %v, db %d", before.Data.StockSeq, f.seq(t, stOutletA))
		}
		b := f.batchFull(t, "order", "st-exp-1", f.payload(pid, 2, stSize))
		it := b.Results[0]
		if it.Status != "ok" || it.StockSeq == nil || *it.StockSeq != *before.Data.StockSeq+1 {
			t.Fatalf("item %+v, want seq %d", it, *before.Data.StockSeq+1)
		}
		if b.StockSeq == nil || *b.StockSeq != f.seq(t, stOutletA) {
			t.Fatalf("batch stockSeq %v db %d", b.StockSeq, f.seq(t, stOutletA))
		}
		// the pull's counter is at least the ack's and its stock already reflects the sale
		p := f.pull(t)
		if p.Data.StockSeq == nil || *p.Data.StockSeq < *it.StockSeq {
			t.Fatalf("pull stockSeq %v < ack %d", p.Data.StockSeq, *it.StockSeq)
		}
		if got, ok := f.pulledStock(p, pid); !ok || got != 8 {
			t.Fatalf("pulled stock %d ok=%v want 8", got, ok)
		}
		if v := f.version(t); v.Data.StockSeq == nil || *v.Data.StockSeq != *b.StockSeq {
			t.Fatalf("version after %v want %d", v.Data.StockSeq, *b.StockSeq)
		}
	})

	t.Run("E2 a duplicate ack carries no item seq and the batch seq does not move", func(t *testing.T) {
		pid := f.product(t, 10)
		p := f.payload(pid, 1, stSize)
		first := f.batchFull(t, "order", "st-exp-dup", p)
		if first.Results[0].StockSeq == nil {
			t.Fatal("first send must carry its seq")
		}
		again := f.batchFull(t, "order", "st-exp-dup", p)
		if r := again.Results[0]; r.Status != "duplicate" || r.StockSeq != nil {
			t.Fatalf("duplicate %+v", r)
		}
		if again.StockSeq == nil || *again.StockSeq != *first.StockSeq {
			t.Fatalf("batch seq moved on a replay: %v vs %v", again.StockSeq, first.StockSeq)
		}
	})

	t.Run("E3 refund and non-order items carry no per-item seq", func(t *testing.T) {
		pid := f.product(t, 10)
		id := f.directSale(t, "st-exp-ref-sale", f.payload(pid, 1, stSize))
		b := f.batchFull(t, "refund", "st-exp-ref", map[string]any{"orderId": id, "reason": "x"})
		if r := b.Results[0]; r.Status != "ok" || r.StockSeq != nil {
			t.Fatalf("refund item %+v", r)
		}
		if b.StockSeq == nil || *b.StockSeq != f.seq(t, stOutletA) {
			t.Fatalf("batch seq %v db %d (the refund bump must be visible there)", b.StockSeq, f.seq(t, stOutletA))
		}
	})

	t.Run("E4 a held transaction: Version() still shows S until it commits, then more", func(t *testing.T) {
		s := f.version(t).Data.StockSeq
		tx, err := f.pool.Begin(f.ctx)
		f.must(t, err)
		if _, err = tx.Exec(f.ctx, `INSERT INTO outlet_stock_seq (outlet_id, seq) VALUES ($1,1)
			ON CONFLICT (outlet_id) DO UPDATE SET seq = outlet_stock_seq.seq + 1`, stOutletA); err != nil {
			t.Fatal(err)
		}
		if got := f.version(t).Data.StockSeq; *got != *s {
			t.Fatalf("uncommitted bump visible: %d vs %d", *got, *s)
		}
		f.must(t, tx.Commit(f.ctx))
		if got := f.version(t).Data.StockSeq; *got <= *s {
			t.Fatalf("after commit %d, want > %d", *got, *s)
		}
	})

	t.Run("E5 a never-bumped outlet reports a real zero, not an absent field", func(t *testing.T) {
		f.exec(t, `INSERT INTO outlets(id,name) VALUES($1,'ST outlet C')`, stOutletC)
		vi, err := f.h.Sync.Version(f.ctx, stOutletC)
		f.must(t, err)
		raw, _ := json.Marshal(vi)
		if vi.StockSeq == nil || *vi.StockSeq != 0 || !strings.Contains(string(raw), `"stockSeq":0`) {
			t.Fatalf("version %s", raw)
		}
	})

	t.Run("E6 SYNC_STOCK_SEQ=off omits every stockSeq and the counter keeps counting", func(t *testing.T) {
		f.h.Sync.StockSeqOff = true
		defer func() { f.h.Sync.StockSeqOff = false }()
		pid := f.product(t, 10)
		a0 := f.seq(t, stOutletA)
		b := f.batchFull(t, "order", "st-exp-off", f.payload(pid, 1, stSize))
		if b.Results[0].Status != "ok" || b.Results[0].StockSeq != nil || b.StockSeq != nil {
			t.Fatalf("batch must carry no seq: %+v batch=%v", b.Results[0], b.StockSeq)
		}
		if v := f.version(t); v.Data.StockSeq != nil {
			t.Fatalf("version carries seq %d", *v.Data.StockSeq)
		}
		if p := f.pull(t); p.Data.StockSeq != nil {
			t.Fatalf("pull carries seq %d", *p.Data.StockSeq)
		}
		if f.seq(t, stOutletA) != a0+1 {
			t.Fatalf("the counter must keep counting while the switch is off")
		}
	})
}
