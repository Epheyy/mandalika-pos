package write

import (
	"errors"
	"testing"

	"github.com/mandalika/pos-backend/internal/apperr"
)

func TestCountStatusStep(t *testing.T) {
	const bad = "bad"
	for _, tt := range []struct {
		from, req string
		want      countStep
		err       string // "" none, "conflict" apperr.Conflict, bad = uncoded 400
	}{
		{"planned", "", stepNone, ""},
		{"planned", "in_progress", stepStart, ""},
		{"in_progress", "in_progress", stepNone, ""}, // double click: no re-freeze
		{"completed", "in_progress", stepNone, "conflict"},
		{"cancelled", "in_progress", stepNone, "conflict"},
		{"planned", "cancelled", stepCancel, ""},
		{"in_progress", "cancelled", stepCancel, ""},
		{"cancelled", "cancelled", stepNone, ""}, // repeat cancel: no-op
		{"completed", "cancelled", stepNone, "conflict"},
		{"planned", "completed", stepNone, bad}, // only the complete route completes
		{"planned", "planned", stepNone, bad},
		{"planned", "bogus", stepNone, bad},
		{"completed", "bogus", stepNone, bad},
	} {
		got, err := countStatusStep(tt.from, tt.req)
		if got != tt.want {
			t.Errorf("%s->%q: step=%v want %v", tt.from, tt.req, got, tt.want)
		}
		code, coded := apperr.CodeOf(err)
		switch tt.err {
		case "":
			if err != nil {
				t.Errorf("%s->%q: unexpected %v", tt.from, tt.req, err)
			}
		case "conflict":
			if !coded || code != apperr.Conflict {
				t.Errorf("%s->%q: want conflict, got %v", tt.from, tt.req, err)
			}
		default:
			if err == nil || coded {
				t.Errorf("%s->%q: want uncoded error, got %v", tt.from, tt.req, err)
			}
		}
	}
}

func TestCountItemsMode(t *testing.T) {
	for _, tt := range []struct {
		status string
		want   itemsMode
		err    bool
	}{
		{"planned", itemsReplace, false},
		{"in_progress", itemsPartial, false},
		{"completed", 0, true},
		{"cancelled", 0, true},
	} {
		got, err := countItemsMode(tt.status)
		if tt.err {
			if !errors.Is(err, ErrCountState) {
				t.Errorf("%s: want ErrCountState, got %v", tt.status, err)
			}
			continue
		}
		if err != nil || got != tt.want {
			t.Errorf("%s: got %v,%v want %v", tt.status, got, err, tt.want)
		}
	}
}

func TestCountDelta(t *testing.T) {
	i := func(v int) *int { return &v }
	for _, tt := range []struct {
		name           string
		actual         int
		baseline       *int
		frozen, expect int
	}{
		{"owner example: frozen 15, counted 14", 14, nil, 15, -1},
		{"owner example: frozen 15, counted 16", 16, nil, 15, 1},
		{"baseline wins over frozen", 11, i(12), 15, -1},
		{"no variance", 10, nil, 10, 0},
		{"baseline zero is a real baseline", 3, i(0), 9, 3},
	} {
		if got := countDelta(tt.actual, tt.baseline, tt.frozen); got != tt.expect {
			t.Errorf("%s: got %d want %d", tt.name, got, tt.expect)
		}
	}
}
