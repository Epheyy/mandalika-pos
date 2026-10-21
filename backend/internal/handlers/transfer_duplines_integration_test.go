package handlers

import (
	"strings"
	"testing"

	"github.com/mandalika/pos-backend/internal/write"
)

// duplicateLineCases: a transfer with two lines of the same (product, size). New
// ones are refused at create/update; legacy ones (already in the table) must still
// move exactly the line total: send -5, receive +5, cancel +5, one ledger row per
// line, and each line keeps its own received_qty/difference. Runs inside
// TestTransferConcurrencyPostgres (shares its fixture).
func (f *trFixture) duplicateLineCases(t *testing.T) {
	t.Run("duplicate-lines/refused-at-create-and-update", func(t *testing.T) {
		src, dst := f.sourceDest("warehouse")
		p := f.product(t)
		dup := []write.TransferItemInput{
			{ProductID: p, VariantSize: "M", Qty: 2},
			{ProductID: "{" + strings.ToUpper(p) + "}", VariantSize: "M", Qty: 3}, // same uuid, other spelling
		}
		_, err := f.repo.CreateTransfer(f.ctx, "", write.TransferCreate{
			Source: write.TransferLoc{Kind: src.kind, ID: src.id},
			Dest:   write.TransferLoc{Kind: dst.kind, ID: dst.id},
			Items:  dup,
		})
		if err == nil {
			t.Fatal("create with a duplicate (product, size) line was accepted")
		}
		id := f.draft(t, src, dst, p, 4)
		if err := f.repo.UpdateTransferDraft(f.ctx, id, write.TransferCreate{Items: dup}); err == nil {
			t.Fatal("update with a duplicate (product, size) line was accepted")
		}
		var lines, qty int
		f.must(t, f.pool.QueryRow(f.ctx,
			`SELECT count(*), COALESCE(sum(sent_qty),0) FROM transfer_items WHERE transfer_id=$1`, id).Scan(&lines, &qty))
		if lines != 1 || qty != 4 {
			t.Errorf("refused update changed the draft: %d lines, qty %d", lines, qty)
		}
	})

	cases := []struct {
		name     string
		items    func(p string) []write.TransferReceiveItem
		reason   string
		wantErr  bool
		wantDest int
		wantDiff int // sum of line differences
	}{
		{name: "omitted", items: func(string) []write.TransferReceiveItem { return nil }, wantDest: 5},
		{name: "itemized-no-reason", items: itemized, wantDest: 5},
		{name: "itemized-with-reason", items: itemized, reason: "cek", wantDest: 5},
		{name: "short-total-with-reason", items: total(4), reason: "kurang 1", wantDest: 4, wantDiff: -1},
		{name: "short-total-no-reason", items: total(4), wantErr: true},
	}
	for _, srcKind := range []string{"outlet", "warehouse"} {
		for _, c := range cases {
			srcKind, c := srcKind, c
			t.Run("duplicate-lines/receive-"+c.name+"/"+srcKind, func(t *testing.T) {
				src, dst := f.sourceDest(srcKind)
				p := f.product(t)
				f.setStock(t, src, p, 10)
				id := f.legacyDuplicateDraft(t, src, dst, p)
				f.must(t, f.repo.SendTransfer(f.ctx, id))
				if got := f.stock(t, src, p); got != 5 {
					t.Fatalf("source stock after send %d, want 5", got)
				}
				f.wantMovements(t, id, "transfer_out", 2, -5, f.stock(t, src, p))

				err := f.repo.ReceiveTransfer(f.ctx, id,
					write.TransferReceive{Items: c.items(p), DiscrepancyReason: c.reason},
					write.ReceiveMeta{ReceivedVia: "backoffice"})
				if c.wantErr {
					if err == nil {
						t.Fatal("receive was accepted, want a refusal (discrepancy without reason)")
					}
					f.wantStatus(t, id, "in_transit")
					if got := f.stock(t, dst, p); got != 0 {
						t.Errorf("refused receive moved dest stock to %d", got)
					}
					f.wantMovements(t, id, "transfer_in", 0, 0, 0)
					return
				}
				if err != nil {
					t.Fatalf("receive: %v", err)
				}
				f.wantStatus(t, id, "completed")
				if got := f.stock(t, dst, p); got != c.wantDest {
					t.Errorf("dest stock %d, want %d", got, c.wantDest)
				}
				f.wantLineResults(t, id, c.wantDest, c.wantDiff)
				// One row per line: a short total of 4 is 2+2 or 3+1, so no line is zero.
				f.wantMovements(t, id, "transfer_in", 2, c.wantDest, f.stock(t, dst, p))
			})
		}
		srcKind := srcKind
		t.Run("duplicate-lines/cancel/"+srcKind, func(t *testing.T) {
			src, dst := f.sourceDest(srcKind)
			p := f.product(t)
			f.setStock(t, src, p, 10)
			id := f.legacyDuplicateDraft(t, src, dst, p)
			f.must(t, f.repo.SendTransfer(f.ctx, id))
			f.must(t, f.repo.CancelTransfer(f.ctx, id))
			f.wantStatus(t, id, "cancelled")
			if got := f.stock(t, src, p); got != 10 {
				t.Errorf("source stock after cancel %d, want 10", got)
			}
			f.wantMovements(t, id, "transfer_cancel", 2, 5, f.stock(t, src, p))
		})
	}
}

func itemized(p string) []write.TransferReceiveItem {
	return []write.TransferReceiveItem{
		{ProductID: p, VariantSize: "M", ReceivedQty: 2},
		{ProductID: p, VariantSize: "M", ReceivedQty: 3},
	}
}

func total(n int) func(string) []write.TransferReceiveItem {
	return func(p string) []write.TransferReceiveItem {
		return []write.TransferReceiveItem{{ProductID: p, VariantSize: "M", ReceivedQty: n}}
	}
}

// legacyDuplicateDraft creates a draft of 2 x (p, M) and adds a second (p, M) line
// of 3 directly in the table, the shape create no longer accepts.
func (f *trFixture) legacyDuplicateDraft(t *testing.T, src, dst loc, p string) string {
	t.Helper()
	id := f.draft(t, src, dst, p, 2)
	f.exec(t, `INSERT INTO transfer_items (transfer_id, product_id, variant_size, sent_qty) VALUES ($1,$2,'M',3)`, id, p)
	return id
}

// wantLineResults: each line carries its own received_qty and difference, the
// received total is wantTotal and the differences add up to wantDiff.
func (f *trFixture) wantLineResults(t *testing.T, id string, wantTotal, wantDiff int) {
	t.Helper()
	rows, err := f.pool.Query(f.ctx,
		`SELECT sent_qty, received_qty, difference FROM transfer_items WHERE transfer_id=$1`, id)
	f.must(t, err)
	defer rows.Close()
	gotTotal, gotDiff := 0, 0
	for rows.Next() {
		var sent int
		var got, diff *int
		f.must(t, rows.Scan(&sent, &got, &diff))
		if got == nil || diff == nil {
			t.Fatalf("line sent %d has no received_qty/difference", sent)
		}
		if *diff != *got-sent {
			t.Errorf("line sent %d received %d has difference %d, want %d", sent, *got, *diff, *got-sent)
		}
		if wantDiff == 0 && *got != sent {
			t.Errorf("full receive: line sent %d shows received %d", sent, *got)
		}
		gotTotal += *got
		gotDiff += *diff
	}
	f.must(t, rows.Err())
	if gotTotal != wantTotal || gotDiff != wantDiff {
		t.Errorf("lines received %d (difference %d), want %d (%d)", gotTotal, gotDiff, wantTotal, wantDiff)
	}
}

// wantMovements: the transfer's ledger rows of one kind are n rows summing to sum, the
// before/after chain is unbroken, and it ends at the location's current stock.
func (f *trFixture) wantMovements(t *testing.T, id, kind string, n, sum, endStock int) {
	t.Helper()
	var count, total, broken int
	f.must(t, f.pool.QueryRow(f.ctx,
		`SELECT count(*), COALESCE(sum(qty),0), count(*) FILTER (WHERE qty_after <> qty_before + qty)
		   FROM stock_movements WHERE ref_type='transfer' AND ref_id=$1 AND kind=$2`, id, kind).Scan(&count, &total, &broken))
	if count != n || total != sum || broken != 0 {
		t.Errorf("%s movements: %d rows summing %d (%d broken), want %d rows summing %d", kind, count, total, broken, n, sum)
	}
	if n == 0 {
		return
	}
	end := "max(qty_after)"
	if sum < 0 {
		end = "min(qty_after)"
	}
	var last int
	f.must(t, f.pool.QueryRow(f.ctx,
		`SELECT `+end+` FROM stock_movements WHERE ref_type='transfer' AND ref_id=$1 AND kind=$2`, id, kind).Scan(&last))
	if last != endStock {
		t.Errorf("%s movements end at %d, stock is %d", kind, last, endStock)
	}
}
