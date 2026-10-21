package rules

import "time"

// A08: pure lockout policy for the receive-approval PIN. The write layer loads the
// state under a row lock, calls NextLockout, and stores the result; nothing here
// touches the clock or the database.

// LockoutState mirrors one receive_pin_lockouts row.
type LockoutState struct {
	Failures    int // consecutive failures since the last lock or success
	LockCycles  int // locks applied since the last success
	LockedUntil *time.Time
	HardLocked  bool // only an admin action clears it
}

// LockoutParams is the per-subject policy.
type LockoutParams struct {
	Threshold int           // consecutive failures that trigger a lock
	Base      time.Duration // first lock; doubles every cycle
	Max       time.Duration // cap for one lock
	HardAfter int           // lock cycle that becomes a hard lock (0 = never)
}

var (
	// ApproverLockout: 5 failures lock 15 min, doubling to 24 h; the 3rd lock is a hard lock.
	ApproverLockout = LockoutParams{Threshold: 5, Base: 15 * time.Minute, Max: 24 * time.Hour, HardAfter: 3}
	// RequesterLockout: 10 failures, same schedule, never a hard lock.
	RequesterLockout = LockoutParams{Threshold: 10, Base: 15 * time.Minute, Max: 24 * time.Hour}
)

type LockoutOutcome int

const (
	LockoutFail LockoutOutcome = iota
	LockoutSuccess
)

// IsLocked reports whether the subject may not attempt a PIN at now.
func IsLocked(s LockoutState, now time.Time) bool {
	return s.HardLocked || (s.LockedUntil != nil && now.Before(*s.LockedUntil))
}

// RetryAfter is the remaining soft-lock time (0 when unlocked or hard locked).
func RetryAfter(s LockoutState, now time.Time) time.Duration {
	if s.HardLocked || s.LockedUntil == nil || !now.Before(*s.LockedUntil) {
		return 0
	}
	return s.LockedUntil.Sub(now)
}

// NextLockout returns the state after one attempt. Success clears everything
// (failures, cycles and any expired lock); a failure counts toward the threshold.
func NextLockout(s LockoutState, now time.Time, outcome LockoutOutcome, p LockoutParams) LockoutState {
	if outcome == LockoutSuccess {
		return LockoutState{}
	}
	s.Failures++
	if s.Failures < p.Threshold {
		return s
	}
	s.Failures = 0
	s.LockCycles++
	d := p.Base
	for i := 1; i < s.LockCycles && d < p.Max; i++ {
		d *= 2
	}
	if d > p.Max {
		d = p.Max
	}
	until := now.Add(d)
	s.LockedUntil = &until
	if p.HardAfter > 0 && s.LockCycles >= p.HardAfter {
		s.HardLocked = true
	}
	return s
}
