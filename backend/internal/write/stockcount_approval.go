package write

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Inventory controls S3: submit, approve and reject a stock count. Stock is only touched through
// finishCount (stockcount.go), the same path a direct completion takes, so the deltas, the
// ledger rows (kind count) and the stock counter are identical either way.

// CountSubmitLine is an optional per-line reason set at submit.
type CountSubmitLine struct {
	ProductID   string `json:"productId"`
	VariantSize string `json:"variantSize"`
	ReasonCode  string `json:"reasonCode"`
	ReasonText  string `json:"reasonText"`
}

// CountSubmit is a finished count handed to an approver, with a count-level reason.
type CountSubmit struct {
	ReasonCode string            `json:"reasonCode"`
	ReasonText string            `json:"reasonText"`
	Lines      []CountSubmitLine `json:"lines"`
}

// countVariance counts the counted lines whose delta is not zero and sums the deltas, by the
// same rule applyCountDeltas applies (counted minus baseline, or minus the frozen quantity).
func countVariance(ctx context.Context, t pgx.Tx, id string) (nonZero, net int, err error) {
	rows, err := t.Query(ctx,
		`SELECT frozen_qty, actual_qty, baseline_qty FROM stock_count_items
		  WHERE stock_count_id=$1 AND actual_qty IS NOT NULL`, id)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var frozen, actual int
		var baseline *int
		if err := rows.Scan(&frozen, &actual, &baseline); err != nil {
			return 0, 0, err
		}
		if d := countDelta(actual, baseline, frozen); d != 0 {
			nonZero++
			net += d
		}
	}
	return nonZero, net, rows.Err()
}

// requireApprovalForVariance is the guard of the direct completion: with approval on, a count
// that would change stock must be submitted instead. A count with no difference completes
// directly (nothing to approve).
func requireApprovalForVariance(ctx context.Context, t pgx.Tx, id string) error {
	on, err := approvalRequiredOn(ctx, t)
	if err != nil || !on {
		return err
	}
	nonZero, _, err := countVariance(ctx, t, id)
	if err != nil {
		return err
	}
	if nonZero > 0 {
		return ErrApprovalRequired
	}
	return nil
}

// countApprovalRow is a count read under its row lock for approve and reject. Unlike lockCount
// it needs no caller outlet: the approver's scope is checked against the count's own location.
type countApprovalRow struct {
	countRow
	submittedBy string
}

func lockCountForDecision(ctx context.Context, t pgx.Tx, id string) (countApprovalRow, error) {
	var c countApprovalRow
	if !isUUID(id) {
		return c, ErrNotFound
	}
	var oid, wid *string
	var submitter *string
	err := t.QueryRow(ctx,
		`SELECT status, outlet_id::text, warehouse_id::text, submitted_by::text FROM stock_counts WHERE id=$1 FOR UPDATE`, id).
		Scan(&c.status, &oid, &wid, &submitter)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ErrNotFound
	}
	if err != nil {
		return c, err
	}
	if wid != nil {
		c.loc.warehouseID = *wid
	} else if oid != nil {
		c.loc.outletID = *oid
	}
	if submitter != nil {
		c.submittedBy = *submitter
	}
	return c, nil
}

// saveSubmitReasons stores the per-line reasons; a line that is not on the count is an input error.
func saveSubmitReasons(ctx context.Context, t pgx.Tx, id string, lines []CountSubmitLine) error {
	for _, l := range lines {
		if l.ReasonCode == "" {
			continue
		}
		if err := validateReason(l.ReasonCode, l.ReasonText); err != nil {
			return err
		}
		ct, err := t.Exec(ctx,
			`UPDATE stock_count_items SET reason_code=$4, reason_text=$5
			  WHERE stock_count_id=$1 AND product_id=$2 AND variant_size=$3`,
			id, l.ProductID, l.VariantSize, l.ReasonCode, nullStr(strings.TrimSpace(l.ReasonText)))
		if err != nil {
			return err
		}
		if ct.RowsAffected() == 0 {
			return fmt.Errorf("produk %s (%s) tidak ada di stock count ini", l.ProductID, l.VariantSize)
		}
	}
	return nil
}

// SubmitStockCountTx sends an in-progress count to an approver (status pending_approval), inside
// the caller's transaction (an idempotency receipt claim). A count with no difference has nothing
// to approve: it completes directly instead, exactly as a direct completion would.
func (r *Repo) SubmitStockCountTx(ctx context.Context, t pgx.Tx, id, outletID, actor string, s CountSubmit) error {
	if err := validateReason(s.ReasonCode, s.ReasonText); err != nil {
		return err
	}
	c, err := lockCount(ctx, t, id, outletID)
	if err != nil {
		return err
	}
	if c.status != "in_progress" {
		return fmt.Errorf("%w (status: %s)", ErrCountState, c.status)
	}
	if err := saveSubmitReasons(ctx, t, id, s.Lines); err != nil {
		return err
	}
	nonZero, net, err := countVariance(ctx, t, id)
	if err != nil {
		return err
	}
	if _, err := t.Exec(ctx,
		`UPDATE stock_counts SET reason_code=$2, reason_text=$3, rejected_note=NULL WHERE id=$1`,
		id, s.ReasonCode, nullStr(strings.TrimSpace(s.ReasonText))); err != nil {
		return err
	}
	if nonZero == 0 {
		if err := insertDocEvent(ctx, t, docTypeStockCount, id, "applied", actor, "tanpa selisih: selesai tanpa persetujuan",
			map[string]any{"lines": 0, "netDelta": 0}); err != nil {
			return err
		}
		return finishCount(ctx, t, id, c, actor, "")
	}
	if _, err := t.Exec(ctx,
		`UPDATE stock_counts SET status='pending_approval', submitted_by=$2, submitted_at=now() WHERE id=$1`,
		id, actor); err != nil {
		return runningCountConflict(err)
	}
	return insertDocEvent(ctx, t, docTypeStockCount, id, "submitted", actor, s.ReasonText,
		map[string]any{"lines": nonZero, "netDelta": net, "reasonCode": s.ReasonCode})
}

// ApproveStockCountTx applies a submitted count's deltas (ledger kind count) and completes it,
// inside the caller's transaction. The proof comes from VerifyInventoryApprover; the approver is
// re-checked here and is never the submitter.
func (r *Repo) ApproveStockCountTx(ctx context.Context, t pgx.Tx, id string, p ApprovalProof, note string) error {
	c, err := lockCountForDecision(ctx, t, id)
	if err != nil {
		return err
	}
	if c.status != "pending_approval" {
		return ErrApprovalNotPending
	}
	if c.submittedBy != "" && strings.EqualFold(c.submittedBy, p.ApproverID) {
		return ErrApprovalSelf
	}
	if err := recheckApprover(ctx, t, p, c.loc.outletID); err != nil {
		return err
	}
	nonZero, net, err := countVariance(ctx, t, id)
	if err != nil {
		return err
	}
	if err := insertDocEvent(ctx, t, docTypeStockCount, id, "approved", p.ApproverID, note, nil); err != nil {
		return err
	}
	if err := insertDocEvent(ctx, t, docTypeStockCount, id, "applied", p.ApproverID, "",
		map[string]any{"lines": nonZero, "netDelta": net}); err != nil {
		return err
	}
	// The count's stock deltas are attributed to who submitted it; the approver is on the count.
	return finishCount(ctx, t, id, c.countRow, c.submittedBy, p.ApproverID)
}

// RejectStockCountTx sends a submitted count back to in_progress for a recount. The decider must
// be an approver for the count's location (no PIN: nothing is applied). The submitter may also
// reject, which withdraws their own submission.
func (r *Repo) RejectStockCountTx(ctx context.Context, t pgx.Tx, id, userID, note string) error {
	c, err := lockCountForDecision(ctx, t, id)
	if err != nil {
		return err
	}
	if err := requireApprover(ctx, t, userID, c.loc.outletID); err != nil {
		return err
	}
	if c.status != "pending_approval" {
		return ErrApprovalNotPending
	}
	if _, err := t.Exec(ctx,
		`UPDATE stock_counts SET status='in_progress', rejected_note=$2 WHERE id=$1`,
		id, strings.TrimSpace(note)); err != nil {
		return runningCountConflict(err)
	}
	return insertDocEvent(ctx, t, docTypeStockCount, id, "rejected", userID, note, nil)
}
