package sync

import "time"

// Offline cap constants (A05). The verdict itself lives next to this file.
const (
	OfflineCap     = 12 * time.Hour
	ClockTolerance = 5 * time.Minute
)
