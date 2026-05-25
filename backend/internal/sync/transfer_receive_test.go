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

func TestReceiveScope(t *testing.T) {
	const (
		outletA = "outlet-a"
		outletB = "outlet-b"
	)
	cases := []struct {
		name           string
		callerOutlet   string
		destOutlet     string
		approverRole   string
		approverOutlet string
		wantErr        string
	}{
		{
			name:         "ok: approver assigned to dest outlet",
			callerOutlet: outletA, destOutlet: outletA,
			approverRole: "manager", approverOutlet: outletA,
			wantErr: "",
		},
		{
			name:         "ok: admin approver with no outlet assignment",
			callerOutlet: outletA, destOutlet: outletA,
			approverRole: "admin", approverOutlet: "",
			wantErr: "",
		},
		{
			name:         "ok: admin approver assigned to different outlet",
			callerOutlet: outletA, destOutlet: outletA,
			approverRole: "admin", approverOutlet: outletB,
			wantErr: "",
		},
		{
			name:         "blocked: dest outlet is a warehouse (empty)",
			callerOutlet: outletA, destOutlet: "",
			approverRole: "manager", approverOutlet: outletA,
			wantErr: "transfer bukan untuk outlet ini",
		},
		{
			name:         "blocked: dest outlet differs from caller outlet",
			callerOutlet: outletA, destOutlet: outletB,
			approverRole: "manager", approverOutlet: outletB,
			wantErr: "transfer bukan untuk outlet ini",
		},
		{
			name:         "blocked: approver not assigned to dest outlet (non-admin)",
			callerOutlet: outletA, destOutlet: outletA,
			approverRole: "manager", approverOutlet: outletB,
			wantErr: "tidak berwenang",
		},
		{
			name:         "blocked: approver has no outlet (non-admin)",
			callerOutlet: outletA, destOutlet: outletA,
			approverRole: "manager", approverOutlet: "",
			wantErr: "tidak berwenang",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := receiveScope(c.callerOutlet, c.destOutlet, c.approverRole, c.approverOutlet)
			if got != c.wantErr {
				t.Fatalf("receiveScope(%q,%q,%q,%q)=%q want %q",
					c.callerOutlet, c.destOutlet, c.approverRole, c.approverOutlet, got, c.wantErr)
			}
		})
	}
}
