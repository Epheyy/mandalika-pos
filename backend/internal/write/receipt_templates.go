package write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/receipttpl"
)

// ReceiptTemplateIn is a template as the Backoffice sends it. IsDefault is read on create only.
type ReceiptTemplateIn struct {
	Name       string
	PaperWidth int
	Blocks     []api.ReceiptBlock
	IsDefault  bool
}

// ReceiptTemplateConflict is a 409: a refusal whose Indonesian message the Backoffice shows verbatim.
type ReceiptTemplateConflict struct{ Msg string }

func (e *ReceiptTemplateConflict) Error() string { return e.Msg }

const (
	msgTemplateStale   = "Template ini sudah diubah di tempat lain. Muat ulang lalu ulangi."
	msgTemplateNameDup = "Nama template sudah dipakai."
	msgTemplateDefault = "Template Standar sudah ada."
	msgTemplateLimit   = "Maksimal 50 template."
	msgDeleteStandar   = "Template Standar tidak bisa dihapus."

	templatesResource = "receipt_templates"
	pgUniqueViolation = "23505"
	idxTemplateName   = "receipt_templates_name_uq"
	idxTemplateDef    = "receipt_templates_default_uq"
)

// templateConflict turns a unique violation of the two template indexes into a 409.
func templateConflict(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == pgUniqueViolation {
		switch pg.ConstraintName {
		case idxTemplateName:
			return &ReceiptTemplateConflict{Msg: msgTemplateNameDup}
		case idxTemplateDef:
			return &ReceiptTemplateConflict{Msg: msgTemplateDefault}
		}
	}
	return err
}

func validateTemplateIn(in ReceiptTemplateIn) error {
	return receipttpl.Validate(in.Name, in.PaperWidth, in.Blocks)
}

// runTemplateTx runs fn in a transaction and then bumps the content version of the outlets fn returns,
// so only tablets whose resolved template changed pull again.
func (r *Repo) runTemplateTx(ctx context.Context, fn func(pgx.Tx) ([]string, error)) error {
	t, err := r.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer t.Rollback(ctx)
	outlets, err := fn(t)
	if err != nil {
		return templateConflict(err)
	}
	if err := bumpVersionOutlets(ctx, t, templatesResource, outlets); err != nil {
		return fmt.Errorf("bump version: %w", err)
	}
	return t.Commit(ctx)
}

func queryIDs(ctx context.Context, t pgx.Tx, sql string, args ...any) ([]string, error) {
	rows, err := t.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CreateReceiptTemplate stores a new template and returns its id. IsDefault is accepted only while
// no default exists (saving Standar); a plain create changes what no outlet prints.
func (r *Repo) CreateReceiptTemplate(ctx context.Context, actor string, in ReceiptTemplateIn) (string, error) {
	if err := validateTemplateIn(in); err != nil {
		return "", err
	}
	blocks, err := json.Marshal(in.Blocks)
	if err != nil {
		return "", err
	}
	var id string
	err = r.runTemplateTx(ctx, func(t pgx.Tx) ([]string, error) {
		var n int
		if err := t.QueryRow(ctx, `SELECT count(*) FROM receipt_templates`).Scan(&n); err != nil {
			return nil, err
		}
		if n >= receipttpl.TemplatesMax {
			return nil, &ReceiptTemplateConflict{Msg: msgTemplateLimit}
		}
		if in.IsDefault {
			var exists bool
			if err := t.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM receipt_templates WHERE is_default)`).Scan(&exists); err != nil {
				return nil, err
			}
			if exists {
				return nil, &ReceiptTemplateConflict{Msg: msgTemplateDefault}
			}
		}
		if err := t.QueryRow(ctx,
			`INSERT INTO receipt_templates (name, paper_width, blocks, is_default, updated_by)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id::text`,
			receipttpl.TrimName(in.Name), in.PaperWidth, blocks, in.IsDefault, nilIfEmpty(actor)).Scan(&id); err != nil {
			return nil, err
		}
		if !in.IsDefault {
			return nil, nil
		}
		// A saved Standar now applies to every outlet that has no assignment.
		return queryIDs(ctx, t, `SELECT id::text FROM outlets WHERE receipt_template_id IS NULL`)
	})
	return id, err
}

// UpdateReceiptTemplate saves a template. version is the one the editor loaded: a stale one is a 409.
// It never reads in.IsDefault: nothing moves the default.
func (r *Repo) UpdateReceiptTemplate(ctx context.Context, actor, id string, in ReceiptTemplateIn, version int) error {
	if _, err := uuid.Parse(id); err != nil {
		return ErrNotFound
	}
	if err := validateTemplateIn(in); err != nil {
		return err
	}
	blocks, err := json.Marshal(in.Blocks)
	if err != nil {
		return err
	}
	return r.runTemplateTx(ctx, func(t pgx.Tx) ([]string, error) {
		var stored int
		var isDefault bool
		err := t.QueryRow(ctx, `SELECT version, is_default FROM receipt_templates WHERE id=$1 FOR UPDATE`, id).Scan(&stored, &isDefault)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if stored != version {
			return nil, &ReceiptTemplateConflict{Msg: msgTemplateStale}
		}
		if _, err := t.Exec(ctx,
			`UPDATE receipt_templates SET name=$2, paper_width=$3, blocks=$4, version=version+1,
			        updated_at=now(), updated_by=$5 WHERE id=$1`,
			id, receipttpl.TrimName(in.Name), in.PaperWidth, blocks, nilIfEmpty(actor)); err != nil {
			return nil, err
		}
		return queryIDs(ctx, t,
			`SELECT id::text FROM outlets WHERE receipt_template_id=$1 OR ($2 AND receipt_template_id IS NULL)`,
			id, isDefault)
	})
}

// DeleteReceiptTemplate removes a template that is neither the default nor assigned to an outlet.
func (r *Repo) DeleteReceiptTemplate(ctx context.Context, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return ErrNotFound
	}
	return r.runTemplateTx(ctx, func(t pgx.Tx) ([]string, error) {
		var isDefault bool
		err := t.QueryRow(ctx, `SELECT is_default FROM receipt_templates WHERE id=$1 FOR UPDATE`, id).Scan(&isDefault)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if isDefault {
			return nil, &ReceiptTemplateConflict{Msg: msgDeleteStandar}
		}
		var used int
		if err := t.QueryRow(ctx, `SELECT count(*) FROM outlets WHERE receipt_template_id=$1`, id).Scan(&used); err != nil {
			return nil, err
		}
		if used > 0 {
			return nil, &ReceiptTemplateConflict{Msg: fmt.Sprintf("Template masih dipakai di %d outlet. Pindahkan outletnya dulu.", used)}
		}
		_, err = t.Exec(ctx, `DELETE FROM receipt_templates WHERE id=$1`, id)
		return nil, err
	})
}

// AssignReceiptTemplate moves outlets onto a template. With an id, the listed outlets move to it and
// outlets that were on it but are not listed go back to the default. With nil, or the default's own
// id, the listed outlets go back to the default; no other outlet is touched.
func (r *Repo) AssignReceiptTemplate(ctx context.Context, templateID *string, outletIDs []string) error {
	for _, o := range outletIDs {
		if _, err := uuid.Parse(o); err != nil {
			return ErrNotFound
		}
	}
	if templateID != nil {
		if _, err := uuid.Parse(*templateID); err != nil {
			return ErrNotFound
		}
	}
	return r.runTemplateTx(ctx, func(t pgx.Tx) ([]string, error) {
		var target *string
		if templateID != nil {
			var isDefault bool
			err := t.QueryRow(ctx, `SELECT is_default FROM receipt_templates WHERE id=$1 FOR SHARE`, *templateID).Scan(&isDefault)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrNotFound
			}
			if err != nil {
				return nil, err
			}
			if !isDefault {
				target = templateID
			}
		}
		if len(outletIDs) > 0 {
			var found int
			if err := t.QueryRow(ctx, `SELECT count(*) FROM outlets WHERE id = ANY($1::uuid[])`, outletIDs).Scan(&found); err != nil {
				return nil, err
			}
			if found != len(distinctIDs(outletIDs)) {
				return nil, ErrNotFound
			}
		}
		if target == nil {
			return queryIDs(ctx, t,
				`UPDATE outlets SET receipt_template_id=NULL
				  WHERE id = ANY($1::uuid[]) AND receipt_template_id IS NOT NULL RETURNING id::text`, outletIDs)
		}
		moved, err := queryIDs(ctx, t,
			`UPDATE outlets SET receipt_template_id=$1
			  WHERE id = ANY($2::uuid[]) AND receipt_template_id IS DISTINCT FROM $1::uuid RETURNING id::text`, *target, outletIDs)
		if err != nil {
			return nil, err
		}
		dropped, err := queryIDs(ctx, t,
			`UPDATE outlets SET receipt_template_id=NULL
			  WHERE receipt_template_id=$1 AND NOT (id = ANY($2::uuid[])) RETURNING id::text`, *target, outletIDs)
		if err != nil {
			return nil, err
		}
		return append(moved, dropped...), nil
	})
}

func distinctIDs(ids []string) map[string]struct{} {
	m := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		m[strings.ToLower(id)] = struct{}{}
	}
	return m
}
