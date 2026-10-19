package sync

import (
	"log/slog"
	"time"
)

// Offline cap constants (A05).
const (
	OfflineCap     = 12 * time.Hour
	ClockTolerance = 5 * time.Minute
)

// offlineExpiredMessage is shown on the tablet's review screen and in backoffice.
const offlineExpiredMessage = "Transaksi dicatat lebih dari 12 jam setelah tablet terakhir online sehingga tidak diproses otomatis. Data tetap tersimpan dan ditinjau kantor pusat. Jangan input ulang."

// cappedTypes are the operations the cap refuses. Shift open/close are exempt (the
// drawer must always close), customer_create too (a refused customer would trap its
// order in a retry loop), and transfer_receive is bounded by A08 instead: its approval
// grant expires 12 h after it is minted (write.ReceiveApprovalTTL), measured on the server clock.
func cappedType(t string) bool {
	switch t {
	case "order", "refund", "cash_flow":
		return true
	}
	return false
}

// offlineEvidence is what a batch item says about how long its tablet was offline.
type offlineEvidence struct {
	Any  bool          // the envelope carried any evidence at all
	LOK  bool          // a contact whose signature verifies for this device and is not future
	L    time.Time     // the verified contact time (valid when LOK)
	HasE bool          // E is known
	E    time.Duration // offline time claimed by the device (the larger of its two measures)
}

// readEvidence extracts the evidence from an envelope. arrival is the server time the
// batch was processed at.
func readEvidence(env Envelope, arrival time.Time, key []byte) offlineEvidence {
	var ev offlineEvidence
	ev.Any = env.Contact != nil || env.ContactDeviceAt != nil || env.OfflineMs != nil
	if env.Contact != nil {
		ev.L, ev.LOK = VerifyContact(key, env.DeviceID, *env.Contact, arrival)
	}
	if env.OfflineMs != nil {
		ev.E, ev.HasE = time.Duration(*env.OfflineMs)*time.Millisecond, true
	}
	if env.ContactDeviceAt != nil && !env.CapturedAt.IsZero() {
		d := env.CapturedAt.Sub(time.UnixMilli(*env.ContactDeviceAt))
		if !ev.HasE || d > ev.E {
			ev.E, ev.HasE = d, true
		}
	}
	return ev
}

// capVerdict decides whether a batch item exceeded the 12 h offline cap. It is a pure
// function of the item type, envelope, arrival time and contact key. refuse = the item
// must be refused as offline_expired; warn is a log reason for evidence that does not
// add up (the item is still accepted).
//
// Evidence is never required: an item without any (an older bundle, or no contact yet)
// is accepted, and a late sync alone is legitimate.
func capVerdict(typ string, env Envelope, arrival time.Time, key []byte) (refuse bool, warn string) {
	if !cappedType(typ) {
		return false, ""
	}
	ev := readEvidence(env, arrival, key)
	if !ev.Any {
		slog.Info("no offline evidence on capped sync item", "type", typ, "deviceId", env.DeviceID)
		return false, ""
	}
	// Evidence that does not add up is flagged (never refused) before any early return, so a
	// device with a clock set forward is logged even on the fast path.
	inconsistent := ""
	if ev.HasE && (ev.E < -ClockTolerance || (ev.LOK && ev.L.Add(ev.E).After(arrival.Add(ClockTolerance)))) {
		inconsistent = "offline evidence inconsistent"
	}
	// Fast path: a server-signed contact within the cap of arrival, independent of the
	// tablet's clock.
	if ev.LOK && arrival.Sub(ev.L) <= OfflineCap+ClockTolerance {
		return false, inconsistent
	}
	if !ev.HasE {
		return false, ""
	}
	if ev.E > OfflineCap+ClockTolerance {
		return true, ""
	}
	return false, inconsistent
}

// boundSaleTime bounds the time promo and loyalty rules evaluate at (A05). It never
// changes the stored client_created_at; it returns the evaluation time to use (nil =
// keep the client's) and whether the clock disagreed with the evidence.
//
// With a verified contact L the sale must lie in [L-tol, A+tol]; otherwise the time is
// clamp(L+E, L, A) (clamp(C, L, A) when E is unknown). Without one, only a future C is
// bounded (to A): a late sync is legitimate, so there is no lower bound.
func boundSaleTime(ev offlineEvidence, c *time.Time, arrival time.Time) (*time.Time, bool) {
	if c == nil {
		return nil, false
	}
	if !ev.LOK {
		if c.After(arrival.Add(ClockTolerance)) {
			a := arrival
			return &a, true
		}
		return nil, false
	}
	if !c.Before(ev.L.Add(-ClockTolerance)) && !c.After(arrival.Add(ClockTolerance)) {
		return nil, false
	}
	t := *c
	if ev.HasE {
		t = ev.L.Add(ev.E)
	}
	if t.Before(ev.L) {
		t = ev.L
	}
	if t.After(arrival) {
		t = arrival
	}
	return &t, true
}
