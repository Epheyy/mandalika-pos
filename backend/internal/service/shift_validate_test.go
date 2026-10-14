package service

import (
	"context"
	"errors"
	"testing"
)

// ValidateShiftOutlet refuses (never panics or hits SQL) for an empty/malformed
// outlet or shift id, and accepts an empty shiftId without touching the pool.
func TestValidateShiftOutletLocalChecks(t *testing.T) {
	s := &OrderService{} // nil pool: any query would panic
	const id = "11111111-1111-4111-8111-111111111111"
	for _, c := range []struct{ outlet, shift string }{{"", id}, {"not-a-uuid", id}, {id, "not-a-uuid"}} {
		if err := s.ValidateShiftOutlet(context.Background(), c.outlet, c.shift); !errors.Is(err, ErrShiftNotInOutlet) {
			t.Fatalf("outlet=%q shift=%q: %v", c.outlet, c.shift, err)
		}
	}
	if err := s.ValidateShiftOutlet(context.Background(), "", ""); err != nil {
		t.Fatalf("empty shiftId must be allowed: %v", err)
	}
}
