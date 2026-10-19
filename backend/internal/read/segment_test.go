package read

import (
	"strings"
	"testing"
)

// Segment recency counts whole days in Asia/Jakarta, never the database session zone (A28).
func TestSegmentRecencyUsesJakartaDays(t *testing.T) {
	if strings.Contains(segmentMatch, "now()::date") || strings.Contains(segmentMatch, "last_visit::date") {
		t.Fatalf("segmentMatch depends on the session timezone: %s", segmentMatch)
	}
	if n := strings.Count(segmentMatch, "AT TIME ZONE 'Asia/Jakarta'"); n != 4 {
		t.Fatalf("expected 2 recency bounds x 2 operands in Asia/Jakarta, found %d", n)
	}
}
