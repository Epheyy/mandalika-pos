package sync

import "testing"

func TestApproverAllowed(t *testing.T) {
	cases := []struct {
		name   string
		role   string
		roles  []string
		wantOK bool
	}{
		{"manager allowed", "manager", []string{"manager"}, true},
		{"admin always", "admin", []string{"manager"}, true},
		{"cashier denied", "cashier", []string{"manager"}, false},
		{"empty roles denies non-admin", "manager", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := approverAllowed(c.role, c.roles); got != c.wantOK {
				t.Fatalf("approverAllowed(%q,%v)=%v want %v", c.role, c.roles, got, c.wantOK)
			}
		})
	}
}
