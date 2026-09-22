package service

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestShiftDecodeRepresentation(t *testing.T) {
	for _, op := range []string{"open", "close"} {
		field := "startingCash"
		if op == "close" {
			field = "closingCash"
		}
		decode := func(raw string) error {
			if op == "open" {
				_, err := DecodeOpenShift(strings.NewReader(raw))
				return err
			}
			_, err := DecodeCloseShift(strings.NewReader(raw), false)
			return err
		}
		for _, raw := range []string{"", " ", "null", "[]", "1", `"text"`, "{}", fmt.Sprintf(`{"%s":null}`, field), fmt.Sprintf(`{"%s":"0"}`, field), fmt.Sprintf(`{"%s":true}`, field), fmt.Sprintf(`{"%s":1e999}`, field), fmt.Sprintf(`{"%s":1000000000000}`, field), fmt.Sprintf(`{"%s":-1000000000000}`, field), fmt.Sprintf(`{"%s":0,`, field), fmt.Sprintf(`{"%s":0}{}`, field), fmt.Sprintf(`{"%s":0}junk`, field), fmt.Sprintf(`{"%s":0,"%s":1}`, field, field), fmt.Sprintf(`{"%s":0,"%s":0}`, field, strings.ToUpper(field))} {
			t.Run(op+"/reject/"+raw, func(t *testing.T) {
				if err := decode(raw); !errors.Is(err, ErrShiftInput) {
					t.Fatalf("err=%v", err)
				}
			})
		}
		for _, amount := range []string{"0", "1.25", "-1.25", "999999999999.99", "-999999999999.99"} {
			raw := fmt.Sprintf("{\"%s\":%s,\"future\":{\"startingCash\":null}} \n\t", strings.ToUpper(field), amount)
			if err := decode(raw); err != nil {
				t.Fatalf("%s: %v", raw, err)
			}
		}
	}
	for _, raw := range []string{`{"startingCash":0}`, `{"startingCash":0,"outletName":null}`, `{"startingCash":0,"outletName":"Optional"}`} {
		if _, err := DecodeOpenShift(strings.NewReader(raw)); err != nil {
			t.Fatal(err)
		}
	}
	for _, raw := range []string{`{"startingCash":0,"outletName":1}`, `{"startingCash":0,"outletName":"a","OutletName":"b"}`} {
		if _, err := DecodeOpenShift(strings.NewReader(raw)); err == nil {
			t.Fatal("invalid outlet name accepted")
		}
	}
}

func TestShiftCountedMethodsAndReference(t *testing.T) {
	for _, suffix := range []string{"", `,"countedByMethod":null`, `,"countedByMethod":{}`} {
		out, err := DecodeCloseShift(strings.NewReader(`{"closingCash":0`+suffix+`}`), false)
		if err != nil || len(out.CountedByMethod) != 0 {
			t.Fatalf("out=%+v err=%v", out, err)
		}
	}
	for _, value := range []string{`{"cash":null}`, `{"cash":"0"}`, `{"cash":1e999}`, `{"cash":0,"cash":1}`, `[]`, `true`, `0`} {
		if _, err := DecodeCloseShift(strings.NewReader(`{"closingCash":100,"countedByMethod":`+value+`}`), false); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
	out, err := DecodeCloseShift(strings.NewReader(`{"closingCash":0,"countedByMethod":{"cash":0,"custom_BANK":-1.25,"CASH":10}}`), false)
	if err != nil || len(out.CountedByMethod) != 3 || out.CountedByMethod["cash"] != 0 || out.CountedByMethod["custom_BANK"] != -1.25 {
		t.Fatalf("%+v %v", out, err)
	}
	out, err = DecodeCloseShift(strings.NewReader(`{"closingCash":0,"countedByMethod":{"custom":1e20}}`), false)
	if err != nil || out.CountedByMethod["custom"] != 1e20 {
		t.Fatal("JSONB count received an invented numeric-column cap", err)
	}
	for _, raw := range []string{`{"closingCash":0}`, `{"closingCash":0,"shiftId":null}`, `{"closingCash":0,"shiftId":" "}`, `{"closingCash":0,"shiftId":3}`, `{"closingCash":0,"shiftId":"a","ShiftID":"b"}`} {
		if _, err := DecodeCloseShift(strings.NewReader(raw), true); err == nil {
			t.Fatalf("batch accepted %s", raw)
		}
	}
	out, err = DecodeCloseShift(strings.NewReader(`{"closingCash":0,"shiftId":"original"}`), true)
	if err != nil || out.ShiftID != "original" {
		t.Fatalf("%+v %v", out, err)
	}
	// Direct routing never uses a body shiftId, even forged metadata of wrong type.
	out, err = DecodeCloseShift(strings.NewReader(`{"closingCash":0,"shiftId":false}`), false)
	if err != nil || out.ShiftID != "" {
		t.Fatalf("%+v %v", out, err)
	}
}
