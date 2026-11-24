package write

import (
	"testing"

	"github.com/mandalika/pos-backend/internal/coverage"
)

func TestApproverCovers(t *testing.T) {
	roles := []string{"manager"}
	a := coverage.Coverage{OutletIDs: []string{"A", "B"}}
	for _, tc := range []struct {
		name string
		role string
		cov  coverage.Coverage
		doc  string
		rls  []string
		want bool
	}{
		{"manager covers extra outlet", "manager", a, "B", roles, true},
		{"manager does not cover other outlet", "manager", a, "C", roles, false},
		{"all-outlets manager", "manager", coverage.Coverage{All: true}, "C", roles, true},
		{"warehouse document needs only the role", "manager", a, "", roles, true},
		{"admin always", "admin", coverage.Coverage{All: true}, "C", nil, true},
		{"cashier in approver roles with home A, doc B", "cashier", coverage.Coverage{OutletIDs: []string{"A"}}, "B", []string{"cashier"}, false},
		{"role outside approver roles", "manager", coverage.Coverage{All: true}, "A", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ApproverCovers(tc.role, tc.cov, tc.doc, tc.rls); got != tc.want {
				t.Fatalf("ApproverCovers=%v want %v", got, tc.want)
			}
		})
	}
}
