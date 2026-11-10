package server

import (
	"regexp"
	"strings"
	"testing"
)

// Every authenticated route group must check the user's rights version, or a
// revoked permission keeps working until the access token expires.
func TestServerAuthGroupsUseRevocation(t *testing.T) {
	src := mustRead(t, "server.go")
	calls := regexp.MustCompile(`mw\.RequireAuth\([^\n]*`).FindAllString(src, -1)
	if len(calls) == 0 {
		t.Fatal("server.go has no mw.RequireAuth call: the guard scanned nothing")
	}
	for _, c := range calls {
		if !strings.Contains(c, "WithRevocation(") {
			t.Errorf("%q must pass mw.WithRevocation(...)", c)
		}
	}
}
