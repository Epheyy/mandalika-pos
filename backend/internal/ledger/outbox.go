package ledger

// ERP outbox enqueue (plan §5.1). Every document part that Record/RecordDeltas writes
// is queued in erp_outbox in the SAME transaction, as the last statement of the part's
// insert batch: the document is queued iff its movements commit, and a rollback leaves
// neither. The row only names the document; the relay (integration/erp) builds the
// payload from stock_movements at first send. Nothing here talks to the ERP, so a POS
// write never waits on it.

// outboxRow is the erp_outbox row of one document part.
type outboxRow struct {
	documentID, docKey, kind, locationType, locationID string
	refType, refID, refNumber                          string
	part, partCount                                    int
}

// outboxRowFor returns the outbox row of part (0 = unsplit) of a document split into
// partCount parts. A document without a source id (backfill) gets its part-0 document
// id as ref id, which every part shares, as the contract requires (ref.id is mandatory
// and equal across parts).
func outboxRowFor(doc Document, documentID string, part, partCount int) outboxRow {
	refID := doc.RefID
	if refID == "" {
		refID = DocumentID(doc.Key, 0)
	}
	return outboxRow{
		documentID: documentID, docKey: doc.Key, kind: string(doc.Kind),
		locationType: string(doc.LocationType), locationID: doc.LocationID,
		refType: doc.RefType, refID: refID, refNumber: doc.RefNumber,
		part: part, partCount: partCount,
	}
}

// enqueueOutboxSQL queues a part only when at least one of its movements exists (the
// batch inserted them just before, or a committed earlier call did): a part whose lines
// were all already recorded under other documents is never queued empty. A replay hits
// the unique document_id and does nothing.
const enqueueOutboxSQL = `
INSERT INTO erp_outbox (document_id, doc_key, kind, location_type, location_id,
  ref_type, ref_id, ref_number, part, part_count, status, hold_reason)
SELECT $1::uuid, $2, $3, $4, $5::uuid, $6, $7::uuid, $8, $9, $10,
       CASE WHEN h.held THEN 'held' ELSE 'pending' END,
       CASE WHEN h.held THEN '` + VoidERPHoldReason + `' END
  FROM (SELECT ($3 = 'void' OR ($6 = 'order' AND EXISTS (
                 SELECT 1 FROM orders o WHERE o.id = $7::uuid AND o.replaces_order_id IS NOT NULL))) AS held) h
 WHERE EXISTS (SELECT 1 FROM stock_movements WHERE document_id = $1::uuid)
ON CONFLICT (document_id) DO NOTHING`

func (o outboxRow) args() []any {
	return []any{o.documentID, o.docKey, o.kind, o.locationType, o.locationID,
		o.refType, o.refID, nullable(o.refNumber), o.part, o.partCount}
}
