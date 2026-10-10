package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/mandalika/pos-backend/internal/apperr"
	"io"
	"math"
	"strings"
)

var ErrShiftInput = apperr.New(apperr.Rejected, "Data shift belum dapat diproses; simpan catatan asli tanpa membuat operasi pengganti")

type OpenShiftBody struct {
	OutletName   string
	StartingCash float64
}

type CloseShiftBody struct {
	ShiftID         string
	ClosingCash     float64
	CountedByMethod map[string]float64
}

func shiftInputError(field string) error { return fmt.Errorf("%w: %s", ErrShiftInput, field) }

// shiftObject reads one complete object. Consumed field names retain Go's
// case-insensitive compatibility but aliases/duplicates cannot choose two values.
// Unconsumed metadata remains forward-compatible. Method IDs use exact case.
func shiftObject(r io.Reader, consumed []string, methodKeys bool) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(r)
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, shiftInputError("JSON object required")
	}
	fields := make(map[string]json.RawMessage)
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return nil, shiftInputError("invalid object")
		}
		key, ok := token.(string)
		if !ok {
			return nil, shiftInputError("invalid field")
		}
		var raw json.RawMessage
		if err = d.Decode(&raw); err != nil {
			return nil, shiftInputError("invalid field value")
		}
		canonical := ""
		if methodKeys {
			canonical = key
		} else {
			for _, name := range consumed {
				if strings.EqualFold(key, name) {
					canonical = name
					break
				}
			}
		}
		if !methodKeys && canonical == "" {
			continue
		}
		if _, exists := fields[canonical]; exists {
			return nil, shiftInputError("duplicate consumed field")
		}
		fields[canonical] = raw
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return nil, shiftInputError("incomplete object")
	}
	var trailing json.RawMessage
	if err = d.Decode(&trailing); err != io.EOF {
		return nil, shiftInputError("unexpected trailing input")
	}
	return fields, nil
}

// Cash is signed in the existing numeric(14,2) schema. This decoder enforces
// representation limits, not a new negative-cash business rule. JSONB method
// counts have no numeric(14,2) column bound; retain their finite float64 domain.
func shiftAmount(raw json.RawMessage, field string, moneyColumn bool) (float64, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, shiftInputError(field + " required")
	}
	var amount float64
	if err := json.Unmarshal(raw, &amount); err != nil || math.IsNaN(amount) || math.IsInf(amount, 0) || (moneyColumn && math.Abs(amount) > maxSaleMoney) {
		return 0, shiftInputError(field + " invalid amount")
	}
	return amount, nil
}

func DecodeOpenShift(r io.Reader) (OpenShiftBody, error) {
	var out OpenShiftBody
	fields, err := shiftObject(r, []string{"startingCash", "outletName"}, false)
	if err != nil {
		return out, err
	}
	out.StartingCash, err = shiftAmount(fields["startingCash"], "startingCash", true)
	if err != nil {
		return OpenShiftBody{}, err
	}
	if raw, ok := fields["outletName"]; ok {
		if err = json.Unmarshal(raw, &out.OutletName); err != nil {
			return OpenShiftBody{}, shiftInputError("outletName invalid")
		}
	}
	return out, nil
}

// Direct close uses the route ID; only a batch close consumes a body shiftId.
// Authority still comes from the authenticated outlet and scoped service lookup.
func DecodeCloseShift(r io.Reader, batch bool) (CloseShiftBody, error) {
	var out CloseShiftBody
	keys := []string{"closingCash", "countedByMethod"}
	if batch {
		keys = append(keys, "shiftId")
	}
	fields, err := shiftObject(r, keys, false)
	if err != nil {
		return out, err
	}
	out.ClosingCash, err = shiftAmount(fields["closingCash"], "closingCash", true)
	if err != nil {
		return CloseShiftBody{}, err
	}
	if batch {
		raw := fields["shiftId"]
		if len(raw) == 0 || json.Unmarshal(raw, &out.ShiftID) != nil || strings.TrimSpace(out.ShiftID) == "" {
			return CloseShiftBody{}, shiftInputError("shiftId required")
		}
	}
	if raw, ok := fields["countedByMethod"]; ok && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		methods, err := shiftObject(bytes.NewReader(raw), nil, true)
		if err != nil {
			return CloseShiftBody{}, err
		}
		out.CountedByMethod = make(map[string]float64, len(methods))
		for method, raw := range methods {
			amount, err := shiftAmount(raw, "countedByMethod amount", false)
			if err != nil {
				return CloseShiftBody{}, err
			}
			out.CountedByMethod[method] = amount
		}
	}
	return out, nil
}
