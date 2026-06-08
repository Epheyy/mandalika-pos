package write

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// validSegmentColors mirrors the tag palette.
var validSegmentColors = map[string]bool{
	"amber": true, "blue": true, "green": true, "red": true,
	"purple": true, "gray": true, "pink": true, "teal": true,
}

type Segment struct {
	Name     string   `json:"name"`
	Color    string   `json:"color"`
	RMin     *int     `json:"rMin,omitempty"`
	RMax     *int     `json:"rMax,omitempty"`
	FMin     *int     `json:"fMin,omitempty"`
	FMax     *int     `json:"fMax,omitempty"`
	MMin     *float64 `json:"mMin,omitempty"`
	MMax     *float64 `json:"mMax,omitempty"`
	IsActive *bool    `json:"isActive,omitempty"`
}

func validateSegment(in Segment) error {
	if in.Name == "" {
		return fmt.Errorf("nama segmen wajib")
	}
	if !validSegmentColors[in.Color] {
		return fmt.Errorf("warna segmen tidak valid")
	}
	if in.RMin != nil && in.RMax != nil && *in.RMin > *in.RMax {
		return fmt.Errorf("R: minimum melebihi maksimum")
	}
	if in.FMin != nil && in.FMax != nil && *in.FMin > *in.FMax {
		return fmt.Errorf("F: minimum melebihi maksimum")
	}
	if in.MMin != nil && in.MMax != nil && *in.MMin > *in.MMax {
		return fmt.Errorf("M: minimum melebihi maksimum")
	}
	return nil
}

func active(in Segment) bool {
	if in.IsActive == nil {
		return true
	}
	return *in.IsActive
}

func (r *Repo) CreateSegment(ctx context.Context, in Segment) (string, error) {
	if err := validateSegment(in); err != nil {
		return "", err
	}
	var id string
	// New rules go last in priority.
	err := r.Pool.QueryRow(ctx,
		`INSERT INTO customer_segments (name, color, sort_order, r_min, r_max, f_min, f_max, m_min, m_max, is_active)
		 VALUES ($1,$2,(SELECT COALESCE(MAX(sort_order),0)+1 FROM customer_segments),$3,$4,$5,$6,$7,$8,$9)
		 RETURNING id`,
		in.Name, in.Color, in.RMin, in.RMax, in.FMin, in.FMax, in.MMin, in.MMax, active(in)).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("create segment: %w", err)
	}
	return id, nil
}

func (r *Repo) UpdateSegment(ctx context.Context, id string, in Segment) error {
	if err := validateSegment(in); err != nil {
		return err
	}
	tag, err := r.Pool.Exec(ctx,
		`UPDATE customer_segments SET name=$2, color=$3, r_min=$4, r_max=$5,
		   f_min=$6, f_max=$7, m_min=$8, m_max=$9, is_active=$10 WHERE id=$1`,
		id, in.Name, in.Color, in.RMin, in.RMax, in.FMin, in.FMax, in.MMin, in.MMax, active(in))
	if err != nil {
		return fmt.Errorf("update segment: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *Repo) DeleteSegment(ctx context.Context, id string) error {
	tag, err := r.Pool.Exec(ctx, `DELETE FROM customer_segments WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete segment: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ReorderSegments sets each segment's sort_order to its index in orderedIds.
func (r *Repo) ReorderSegments(ctx context.Context, orderedIds []string) error {
	return r.tx(ctx, "customer_segments", func(t pgx.Tx) error {
		for i, id := range orderedIds {
			ct, err := t.Exec(ctx, `UPDATE customer_segments SET sort_order=$2 WHERE id=$1`, id, i+1)
			if err != nil {
				return err
			}
			if ct.RowsAffected() == 0 {
				return ErrNotFound
			}
		}
		return nil
	})
}
