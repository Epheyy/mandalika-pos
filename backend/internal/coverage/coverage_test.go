package coverage

import (
	"reflect"
	"testing"
)

func TestOf(t *testing.T) {
	tests := []struct {
		name   string
		role   string
		home   string
		extras []string
		all    bool
		want   Coverage
	}{
		{"admin covers all", "admin", "", nil, false, Coverage{All: true}},
		{"manager all outlets", "manager", "", nil, true, Coverage{All: true}},
		{"manager home plus extras deduped", "manager", "A", []string{"B", "a"}, false, Coverage{OutletIDs: []string{"A", "B"}}},
		{"manager unassigned", "manager", "", []string{}, false, Coverage{OutletIDs: []string{}}},
		{"manager without home ignores extras", "manager", "", []string{"B"}, false, Coverage{OutletIDs: []string{}}},
		{"cashier home only", "cashier", "A", []string{"B"}, false, Coverage{OutletIDs: []string{"A"}}},
		{"cashier unassigned", "cashier", "", nil, false, Coverage{OutletIDs: []string{}}},
		{"unknown role", "ghost", "A", nil, true, Coverage{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Of(tc.role, tc.home, tc.extras, tc.all)
			if got.All != tc.want.All || len(got.OutletIDs) != len(tc.want.OutletIDs) ||
				(len(got.OutletIDs) > 0 && !reflect.DeepEqual(got.OutletIDs, tc.want.OutletIDs)) {
				t.Fatalf("Of() = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestCovers(t *testing.T) {
	if !(Coverage{All: true}).Covers("x") {
		t.Error("All must cover x")
	}
	if !(Coverage{OutletIDs: []string{"A"}}).Covers("a") {
		t.Error("[A] must cover a (case-insensitive)")
	}
	if (Coverage{OutletIDs: []string{"A"}}).Covers("B") {
		t.Error("[A] must not cover B")
	}
	if (Coverage{All: true}).Covers("") || (Coverage{OutletIDs: []string{"A", ""}}).Covers("") {
		t.Error("nothing covers the empty id")
	}
}
