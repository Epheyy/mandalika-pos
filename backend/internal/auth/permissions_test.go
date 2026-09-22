package auth

import (
	"context"
	"testing"
)

func TestHasPermissionSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name       string
		role       any
		perms      any
		permission string
		want       bool
	}{
		{"missing", nil, nil, "process_refund", false},
		{"empty", "", []string{}, "process_refund", false},
		{"invalid claims types", 1, "process_refund", "process_refund", false},
		{"cashier allowed", "cashier", []string{"process_refund"}, "process_refund", true},
		{"cashier unrelated permission", "cashier", []string{"create_order"}, "process_refund", false},
		{"technical admin bypass", "admin", nil, "process_refund", true},
		{"TL is not technical admin", "tl", nil, "process_refund", false},
		{"admin is case sensitive", "Admin", nil, "process_refund", false},
		{"other permission allowed", "cashier", []string{"create_order"}, "create_order", true},
		{"refund cannot grant other permission", "cashier", []string{"process_refund"}, "create_order", false},
		{"existing predicate does not require a role", nil, []string{"process_refund"}, "process_refund", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			if tc.role != nil {
				ctx = context.WithValue(ctx, CtxRole, tc.role)
			}
			if tc.perms != nil {
				ctx = context.WithValue(ctx, CtxPerms, tc.perms)
			}
			if got := HasPermission(ctx, tc.permission); got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}
