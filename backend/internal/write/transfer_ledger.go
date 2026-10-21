package write

import (
	"context"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/mandalika/pos-backend/internal/ledger"
)

// recordTransferMovements writes the stock ledger rows of one transfer step, in the
// writer's transaction and in transferLines order (the order the deltas were applied).
// transfer_out and transfer_cancel hit the source with sent qty (negative for out);
// transfer_in hits the destination with received[i] and is flagged "variance" when it
// differs from the sent qty. Zero-qty lines are skipped by the ledger.
func recordTransferMovements(ctx context.Context, tx pgx.Tx, kind ledger.Kind, id string,
	t transferRow, lines []transferLine, refNumber, actor string, received []int) error {
	outlet, warehouse := t.srcOutlet, t.srcWarehouse
	if kind == ledger.KindTransferIn {
		outlet, warehouse = t.dstOutlet, t.dstWarehouse
	}
	doc := ledger.Document{
		Key: string(kind) + ":" + id, Kind: kind,
		RefType: "transfer", RefID: id, RefNumber: refNumber, Actor: actor,
		OccurredAt: time.Now(),
		Lines:      make([]ledger.Line, 0, len(lines)),
	}
	if outlet != nil {
		doc.LocationType, doc.LocationID = ledger.LocOutlet, *outlet
	} else {
		doc.LocationType, doc.LocationID = ledger.LocWarehouse, *warehouse
	}
	for i, l := range lines {
		ln := ledger.Line{ProductID: l.pid, VariantSize: l.size, Qty: l.sent, RefLine: l.id, DedupeKey: string(kind) + ":" + l.id}
		switch kind {
		case ledger.KindTransferOut:
			ln.Qty = -l.sent
		case ledger.KindTransferIn:
			ln.Qty = received[i]
			if received[i] != l.sent {
				ln.Flags = []string{"variance", "sent:" + strconv.Itoa(l.sent)}
			}
		}
		doc.Lines = append(doc.Lines, ln)
	}
	_, err := ledger.RecordDeltas(ctx, tx, doc)
	return err
}
