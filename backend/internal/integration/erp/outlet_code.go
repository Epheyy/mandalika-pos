package erp

import "regexp"

// posOutletCode is the POS outlet code rule (2-20 chars, upper-case letters, digits and
// inner hyphens). Callers upper-case the code first.
var posOutletCode = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$`)

// ValidPOSOutletCode reports whether code (already upper-cased) can be a POS outlet code.
func ValidPOSOutletCode(code string) bool { return posOutletCode.MatchString(code) }
