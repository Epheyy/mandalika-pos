package handlers

import (
	"context"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/cache"
	"github.com/mandalika/pos-backend/internal/config"
)

func TestXoMaskPhone(t *testing.T) {
	for in, want := range map[string]string{"08123456789": "****6789", "0812": "****0812", "12": "****12", "": "****"} {
		if got := xoMaskPhone(in); got != want {
			t.Errorf("xoMaskPhone(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestXoWindowAllowedLimitsPerUserAndResets(t *testing.T) {
	cc, err := cache.Connect(context.Background(), "", cache.Options{})
	if err != nil {
		t.Fatal(err)
	}
	h := &Handlers{Cache: cc}
	ctx := context.Background()
	now := time.Date(2026, 11, 26, 10, 0, 30, 0, time.UTC) // 30 s into a 10-minute bucket
	for i := 1; i <= config.DefaultXOLookupLimit; i++ {
		if _, ok := h.xoWindowAllowed(ctx, "user-a", now); !ok {
			t.Fatalf("lookup %d refused, the default is %d", i, config.DefaultXOLookupLimit)
		}
	}
	retry, ok := h.xoWindowAllowed(ctx, "user-a", now)
	if ok || retry != 570 {
		t.Fatalf("21st lookup: ok=%v retry=%d, want refused with 570 s left", ok, retry)
	}
	if _, ok := h.xoWindowAllowed(ctx, "user-b", now); !ok {
		t.Fatal("another user must have their own budget")
	}
	if _, ok := h.xoWindowAllowed(ctx, "user-a", now.Add(10*time.Minute)); !ok {
		t.Fatal("the next window must start fresh")
	}
}

func TestXoBudgetEnvKnobs(t *testing.T) {
	h := &Handlers{}
	if l, w := h.xoBudget(); l != 20 || w != 10*time.Minute {
		t.Fatalf("defaults = %d %v", l, w)
	}
	h.SetCrossOutletLookupLimit(5, 2*time.Minute)
	if l, w := h.xoBudget(); l != 5 || w != 2*time.Minute {
		t.Fatalf("configured = %d %v", l, w)
	}
}
