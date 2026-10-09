package service

import "testing"

func TestRequestFingerprint(t *testing.T) {
	fp := func(op, payload string) string {
		t.Helper()
		got, err := RequestFingerprint(op, []byte(payload))
		if err != nil {
			t.Fatalf("fingerprint %s %s: %v", op, payload, err)
		}
		return got
	}
	base := fp("cash_flow", `{"shiftId":"s","amount":10.50,"type":"in"}`)
	if got := fp("cash_flow", ` { "type":"in", "amount":10.50, "shiftId":"s" } `); got != base {
		t.Error("key order and whitespace must not change the fingerprint")
	}
	if fp("cash_flow", `{"shiftId":"s","amount":10.51,"type":"in"}`) == base {
		t.Error("a changed value must change the fingerprint")
	}
	if fp("cash_flow", `{"shiftId":"s","amount":10.5,"type":"in"}`) == base {
		t.Error("numbers are compared verbatim, not as floats")
	}
	if fp("shift_close", `{"shiftId":"s","amount":10.50,"type":"in"}`) == base {
		t.Error("op type must be part of the fingerprint")
	}
	if fp("cash_flow", `{"a":{"b":1,"c":2}}`) != fp("cash_flow", `{"a":{"c":2,"b":1}}`) {
		t.Error("nested key order must not matter")
	}
	for _, bad := range []string{``, `{`, `{} {}`, `{"a":1} junk`} {
		if _, err := RequestFingerprint("cash_flow", []byte(bad)); err == nil {
			t.Errorf("payload %q must be rejected", bad)
		}
	}
}
