// Package bizday holds the outlet timezone rules for business dates (A28).
//
// The business day of a sale is decided in SQL (migration 0059) from the outlet's stored
// timezone; this package only validates the allowed zone names and day strings in handlers
// and gives Go callers the matching zone. Zones are FIXED offsets, not LoadLocation: the
// production binary is static (CGO off, distroless) and ships no zone database, and Indonesia
// has no DST so a fixed offset is exact. The test cross-checks the offsets against tzdata.
package bizday

import "time"

// Default is the zone used for an outlet that has none, for warehouses and for customer-level dates.
const Default = "Asia/Jakarta"

// Allowed maps each permitted outlet timezone to its UTC offset in seconds (WIB, WITA, WIT).
var Allowed = map[string]int{
	"Asia/Jakarta":  7 * 3600,
	"Asia/Makassar": 8 * 3600,
	"Asia/Jayapura": 9 * 3600,
}

// Valid reports whether tz is one of the allowed outlet timezones.
func Valid(tz string) bool {
	_, ok := Allowed[tz]
	return ok
}

// Zone returns the fixed-offset location for tz; an empty or unknown name is the default zone.
func Zone(tz string) *time.Location {
	off, ok := Allowed[tz]
	if !ok {
		tz, off = Default, Allowed[Default]
	}
	return time.FixedZone(tz, off)
}

// ValidDay reports whether s is empty (no bound) or a YYYY-MM-DD calendar day.
func ValidDay(s string) bool {
	if s == "" {
		return true
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}
