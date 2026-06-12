package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
)

var (
	ErrAlreadyMerged       = errors.New("pelanggan sudah digabung sebelumnya")
	ErrCandidateNotPending = errors.New("kandidat duplikat bukan dalam status pending")
	ErrSelfMerge           = errors.New("keeper dan duplikat tidak boleh sama")
	ErrKeeperNotInPair     = errors.New("keeper bukan bagian dari pasangan kandidat ini")
)

// dupRow holds the fields we load from the dup customer for reconciliation and audit.
type dupRow struct {
	id          string
	name        string
	phone       string
	email       string
	notes       string
	birthday    string
	anniversary string
	points      int
	totalSpent  float64
	visitCount  int
	lastVisit   string
	mergedInto  string
}

// keeperRow holds the keeper's current totals needed for reconciliation.
type keeperRow struct {
	id         string
	name       string
	phone      string
	points     int
	totalSpent float64
	visitCount int
	lastVisit  string
	mergedInto string
}

// MergeCustomers merges dupID into keeperID within the context of a dup-candidate
// record. Uses Pool.Begin directly (does NOT bump content_versions / trigger
// outlet resync — mirrors AdjustPoints).
func (r *Repo) MergeCustomers(ctx context.Context, candidateID, keeperID string, fieldChoices map[string]string, byID, byName string) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)

	// 1. Load + lock the candidate.
	var status, newCustID, existCustID string
	err = t.QueryRow(ctx,
		`SELECT status, new_customer_id::text, existing_customer_id::text
		   FROM customer_dup_candidates WHERE id=$1 FOR UPDATE`,
		candidateID).Scan(&status, &newCustID, &existCustID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("load candidate: %w", err)
	}
	if status != "pending" {
		return ErrCandidateNotPending
	}

	// 2. Determine dup — keeperID must equal one of the pair.
	var dupID string
	switch keeperID {
	case newCustID:
		dupID = existCustID
	case existCustID:
		dupID = newCustID
	default:
		return ErrKeeperNotInPair
	}
	if keeperID == dupID {
		return ErrSelfMerge
	}

	// 3. Lock BOTH customer rows FOR UPDATE in deterministic id order.
	first, second := keeperID, dupID
	if keeperID > dupID {
		first, second = dupID, keeperID
	}
	if _, err := t.Exec(ctx,
		`SELECT id FROM customers WHERE id=$1 FOR UPDATE`, first); err != nil {
		return fmt.Errorf("lock customer %s: %w", first, err)
	}
	if _, err := t.Exec(ctx,
		`SELECT id FROM customers WHERE id=$1 FOR UPDATE`, second); err != nil {
		return fmt.Errorf("lock customer %s: %w", second, err)
	}

	// Load keeper fields.
	var keeper keeperRow
	keeper.id = keeperID
	err = t.QueryRow(ctx,
		`SELECT name, phone, points, total_spent, visit_count,
		        COALESCE(last_visit::text,''), COALESCE(merged_into::text,'')
		   FROM customers WHERE id=$1`,
		keeperID).Scan(&keeper.name, &keeper.phone, &keeper.points, &keeper.totalSpent, &keeper.visitCount,
		&keeper.lastVisit, &keeper.mergedInto)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("load keeper: %w", err)
	}
	if keeper.mergedInto != "" {
		return ErrAlreadyMerged
	}

	// Load dup fields.
	var dup dupRow
	dup.id = dupID
	err = t.QueryRow(ctx,
		`SELECT name, phone, COALESCE(email,''), COALESCE(notes,''),
		        COALESCE(birthday::text,''), COALESCE(anniversary::text,''),
		        points, total_spent, visit_count,
		        COALESCE(last_visit::text,''), COALESCE(merged_into::text,'')
		   FROM customers WHERE id=$1`,
		dupID).Scan(&dup.name, &dup.phone, &dup.email, &dup.notes,
		&dup.birthday, &dup.anniversary,
		&dup.points, &dup.totalSpent, &dup.visitCount,
		&dup.lastVisit, &dup.mergedInto)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("load dup: %w", err)
	}
	if dup.mergedInto != "" {
		return ErrAlreadyMerged
	}

	// 4. Validate fieldChoices keys and build dynamic UPDATE on keeper.
	validFields := map[string]bool{
		"name": true, "phone": true, "email": true,
		"birthday": true, "anniversary": true, "notes": true,
	}
	for k := range fieldChoices {
		if !validFields[k] {
			return fmt.Errorf("field tidak valid: %q (harus name/phone/email/birthday/anniversary/notes)", k)
		}
	}

	if len(fieldChoices) > 0 {
		// Build SET list and args for fields where the choice is "dup".
		type fieldVal struct {
			col string
			val any
		}
		var sets []string
		var setArgs []any
		argIdx := 2 // $1 = keeperID

		addField := func(col, textVal string, isDate bool) {
			if choice, ok := fieldChoices[col]; ok && choice == "dup" {
				if isDate {
					sets = append(sets, fmt.Sprintf("%s=$%d::date", col, argIdx))
				} else {
					sets = append(sets, fmt.Sprintf("%s=$%d", col, argIdx))
				}
				setArgs = append(setArgs, nullStr(textVal))
				argIdx++
			}
		}

		// Load keeper's own name/phone for dup-choice fields (we need dup values).
		addField("name", dup.name, false)
		addField("phone", dup.phone, false)
		addField("email", dup.email, false)
		addField("birthday", dup.birthday, true)
		addField("anniversary", dup.anniversary, true)
		addField("notes", dup.notes, false)

		if len(sets) > 0 {
			sql := `UPDATE customers SET ` + strings.Join(sets, ", ") + ` WHERE id=$1`
			args := append([]any{keeperID}, setArgs...)
			if _, err := t.Exec(ctx, sql, args...); err != nil {
				return fmt.Errorf("update keeper fields: %w", err)
			}
		}
	}

	// 5. Tags union: copy dup's tags to keeper (ignore conflicts).
	if _, err := t.Exec(ctx,
		`INSERT INTO customer_tags (customer_id, tag_id)
		   SELECT $1, tag_id FROM customer_tags WHERE customer_id=$2
		   ON CONFLICT DO NOTHING`,
		keeperID, dupID); err != nil {
		return fmt.Errorf("union tags: %w", err)
	}

	// 6. Re-point orders.
	orderRows, err := t.Query(ctx,
		`UPDATE orders SET customer_id=$1 WHERE customer_id=$2 RETURNING id::text`,
		keeperID, dupID)
	if err != nil {
		return fmt.Errorf("repoint orders: %w", err)
	}
	var movedOrderIDs []string
	for orderRows.Next() {
		var oid string
		if err := orderRows.Scan(&oid); err != nil {
			orderRows.Close()
			return fmt.Errorf("scan order id: %w", err)
		}
		movedOrderIDs = append(movedOrderIDs, oid)
	}
	orderRows.Close()
	if err := orderRows.Err(); err != nil {
		return fmt.Errorf("orders query: %w", err)
	}

	// 7. Re-point interactions and loyalty applications.
	if _, err := t.Exec(ctx,
		`UPDATE customer_interactions SET customer_id=$1 WHERE customer_id=$2`,
		keeperID, dupID); err != nil {
		return fmt.Errorf("repoint interactions: %w", err)
	}
	if _, err := t.Exec(ctx,
		`UPDATE loyalty_condition_applications SET customer_id=$1 WHERE customer_id=$2`,
		keeperID, dupID); err != nil {
		return fmt.Errorf("repoint loyalty applications: %w", err)
	}

	// 8. Points reconciliation (skip if dup has 0 points — ledger CHECK forbids 0-point entries).
	pointsMoved := dup.points
	if dup.points != 0 {
		if err := InsertPointTx(ctx, t, PointTxRow{
			CustomerID:   keeperID,
			Type:         "adjust",
			Points:       dup.points,
			BalanceAfter: keeper.points + dup.points,
			Reason:       fmt.Sprintf("Gabung dari %s (%s)", dup.phone, dup.name),
			ByID:         byID,
			ByName:       byName,
		}); err != nil {
			return fmt.Errorf("ledger keeper: %w", err)
		}
		if err := InsertPointTx(ctx, t, PointTxRow{
			CustomerID:   dupID,
			Type:         "adjust",
			Points:       -dup.points,
			BalanceAfter: 0,
			Reason:       fmt.Sprintf("Dipindah ke %s (%s)", keeper.phone, keeper.name),
			ByID:         byID,
			ByName:       byName,
		}); err != nil {
			return fmt.Errorf("ledger dup: %w", err)
		}
	}

	// 9. Aggregate totals on keeper + zero dup points.
	lastVisitArg := nullStr(dup.lastVisit)
	if _, err := t.Exec(ctx,
		`UPDATE customers
		    SET total_spent  = total_spent  + $2,
		        visit_count  = visit_count  + $3,
		        last_visit   = GREATEST(last_visit, $4::timestamptz),
		        points       = points       + $5
		  WHERE id = $1`,
		keeperID, dup.totalSpent, dup.visitCount, lastVisitArg, pointsMoved); err != nil {
		return fmt.Errorf("update keeper aggregates: %w", err)
	}
	if _, err := t.Exec(ctx,
		`UPDATE customers SET points=0 WHERE id=$1`, dupID); err != nil {
		return fmt.Errorf("zero dup points: %w", err)
	}

	// 10. Tombstone dup.
	if _, err := t.Exec(ctx,
		`UPDATE customers SET merged_into=$1, merged_at=now() WHERE id=$2`,
		keeperID, dupID); err != nil {
		return fmt.Errorf("tombstone dup: %w", err)
	}

	// 11. Resolve candidates.
	if _, err := t.Exec(ctx,
		`UPDATE customer_dup_candidates SET status='merged' WHERE id=$1`,
		candidateID); err != nil {
		return fmt.Errorf("resolve candidate: %w", err)
	}
	if _, err := t.Exec(ctx,
		`UPDATE customer_dup_candidates SET status='dismissed'
		  WHERE status='pending'
		    AND (new_customer_id=$1 OR existing_customer_id=$1)`,
		dupID); err != nil {
		return fmt.Errorf("resolve sibling candidates: %w", err)
	}

	// 12. Audit row.
	fcJSON, err := json.Marshal(fieldChoices)
	if err != nil {
		return fmt.Errorf("marshal field choices: %w", err)
	}
	dupSnapshot := map[string]any{
		"id":          dup.id,
		"name":        dup.name,
		"phone":       dup.phone,
		"email":       dup.email,
		"notes":       dup.notes,
		"birthday":    dup.birthday,
		"anniversary": dup.anniversary,
		"points":      dup.points,
		"totalSpent":  dup.totalSpent,
		"visitCount":  dup.visitCount,
		"lastVisit":   dup.lastVisit,
	}
	snapJSON, err := json.Marshal(dupSnapshot)
	if err != nil {
		return fmt.Errorf("marshal dup snapshot: %w", err)
	}
	if _, err := t.Exec(ctx,
		`INSERT INTO customer_merges
		   (keeper_id, dup_id, field_choices, dup_snapshot, moved_order_ids,
		    points_moved, performed_by, performed_by_name)
		 VALUES ($1,$2,$3,$4,$5,$6,NULLIF($7,'')::uuid,NULLIF($8,''))`,
		keeperID, dupID, fcJSON, snapJSON, movedOrderIDs,
		pointsMoved, byID, byName); err != nil {
		return fmt.Errorf("insert audit: %w", err)
	}

	return t.Commit(ctx)
}

// DismissDupCandidate marks a pending dup-candidate as dismissed.
// Returns ErrNotFound if the candidate does not exist or is not pending.
func (r *Repo) DismissDupCandidate(ctx context.Context, id string) error {
	tag, err := r.Pool.Exec(ctx,
		`UPDATE customer_dup_candidates SET status='dismissed'
		  WHERE id=$1 AND status='pending'`, id)
	if err != nil {
		return fmt.Errorf("dismiss candidate: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
