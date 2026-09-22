// Package promotionpreflight scans all stored configs in a read-only snapshot.
package promotionpreflight

import (
	"context"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mandalika/pos-backend/internal/promotionkeys"
)

type Report struct {
	Scanned  int                     `json:"scanned"`
	Findings []promotionkeys.Finding `json:"findings"`
}

func Scan(ctx context.Context, pool *pgxpool.Pool) (Report, error) {
	report := Report{Findings: []promotionkeys.Finding{}}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return report, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id::text,type,is_active,bundle_config,bxgy_config FROM promotions WHERE type IN ('bundle','buy_x_get_y') ORDER BY id`)
	if err != nil {
		return report, err
	}
	defer rows.Close()
	for rows.Next() {
		var p promotionkeys.StoredPromotion
		if err = rows.Scan(&p.ID, &p.Type, &p.IsActive, &p.BundleConfig, &p.BXGYConfig); err != nil {
			return report, err
		}
		report.Scanned++
		report.Findings = append(report.Findings, promotionkeys.Diagnose(p)...)
	}
	if err = rows.Err(); err != nil {
		return report, err
	}
	return report, tx.Commit(ctx)
}
