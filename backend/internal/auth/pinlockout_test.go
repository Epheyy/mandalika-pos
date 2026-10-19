package auth

import (
	"testing"
	"time"
)

var lockNow = time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)

func failN(s LockoutState, n int, params LockoutParams) LockoutState {
	for i := 0; i < n; i++ {
		s = NextLockout(s, lockNow, LockoutFail, params)
	}
	return s
}

func TestNextLockoutApproverPolicy(t *testing.T) {
	p := ApproverLockout
	t.Run("below threshold only counts", func(t *testing.T) {
		s := failN(LockoutState{}, 4, p)
		if s.Failures != 4 || s.LockedUntil != nil || s.HardLocked || s.LockCycles != 0 {
			t.Fatalf("got %+v", s)
		}
	})
	t.Run("threshold locks 15 min and resets failures", func(t *testing.T) {
		s := failN(LockoutState{}, 5, p)
		if s.LockCycles != 1 || s.Failures != 0 || s.LockedUntil == nil || !s.LockedUntil.Equal(lockNow.Add(15*time.Minute)) {
			t.Fatalf("got %+v", s)
		}
	})
	t.Run("second cycle doubles", func(t *testing.T) {
		s := failN(LockoutState{}, 5, p)
		s = failN(s, 5, p)
		if s.LockCycles != 2 || !s.LockedUntil.Equal(lockNow.Add(30*time.Minute)) || s.HardLocked {
			t.Fatalf("got %+v", s)
		}
	})
	t.Run("third cycle hard locks", func(t *testing.T) {
		s := failN(LockoutState{}, 15, p)
		if s.LockCycles != 3 || !s.HardLocked {
			t.Fatalf("got %+v", s)
		}
		if !IsLocked(s, lockNow.Add(1000*time.Hour)) {
			t.Fatal("hard lock must not expire with time")
		}
	})
	t.Run("success resets everything", func(t *testing.T) {
		s := failN(LockoutState{}, 7, p)
		s = NextLockout(s, lockNow, LockoutSuccess, p)
		if s != (LockoutState{}) {
			t.Fatalf("got %+v", s)
		}
	})
}

func TestNextLockoutRequesterPolicy(t *testing.T) {
	p := RequesterLockout
	s := failN(LockoutState{}, 9, p)
	if s.LockedUntil != nil {
		t.Fatalf("9 failures must not lock: %+v", s)
	}
	s = failN(s, 1, p)
	if s.LockCycles != 1 || !s.LockedUntil.Equal(lockNow.Add(15*time.Minute)) {
		t.Fatalf("got %+v", s)
	}
	s = failN(s, 10*10, p) // many more cycles: never hard, capped at 24 h
	if s.HardLocked {
		t.Fatal("requester has no hard lock")
	}
	if !s.LockedUntil.Equal(lockNow.Add(24 * time.Hour)) {
		t.Fatalf("want 24h cap, got %+v", s)
	}
}

func TestIsLockedExpires(t *testing.T) {
	s := failN(LockoutState{}, 5, ApproverLockout)
	if !IsLocked(s, lockNow.Add(14*time.Minute)) {
		t.Fatal("still locked at 14m")
	}
	if IsLocked(s, lockNow.Add(15*time.Minute)) {
		t.Fatal("unlocked at 15m")
	}
	if IsLocked(LockoutState{}, lockNow) {
		t.Fatal("zero state is unlocked")
	}
}

func TestLockoutRetryAfter(t *testing.T) {
	s := failN(LockoutState{}, 5, ApproverLockout)
	if got := RetryAfter(s, lockNow.Add(5*time.Minute)); got != 10*time.Minute {
		t.Fatalf("got %v", got)
	}
	if RetryAfter(LockoutState{}, lockNow) != 0 {
		t.Fatal("unlocked has no retry-after")
	}
}
