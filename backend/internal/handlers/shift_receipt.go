package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"

	"github.com/mandalika/pos-backend/internal/api"
)

// decodeOptionalBody decodes a JSON body that may be absent: an empty body is
// fine (v is left untouched), but a body that is present and malformed (bad
// JSON, wrong types, trailing input) is an error so it is never silently
// treated as "no fields supplied".
func decodeOptionalBody(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing input")
	}
	return nil
}

// shiftOrReceipt returns the read-back shift, or the stable receipt (id and
// outcome) when the read-back failed after the command already committed. A
// zero-value shift must never be returned as if it were the result.
func shiftOrReceipt(v api.Shift, err error, receipt api.Shift) api.Shift {
	if err != nil {
		slog.Error("shift committed but the read-back failed", "shiftId", receipt.Id.String(), "err", err)
		return receipt
	}
	return v
}

func openShiftReceipt(id, outletID, cashierID, cashierName, outletName string, startingCash float64, openedAt time.Time) api.Shift {
	s := api.Shift{
		Id: parseUUIDLoose(id), OutletId: parseUUIDLoose(outletID),
		CashierId: cashierID, CashierName: cashierName,
		Status: api.ShiftStatusOpen, OpenedAt: openedAt, StartingCash: float32(startingCash),
	}
	if outletName != "" {
		s.OutletName = nullable.NewNullableWithValue(outletName)
	}
	return s
}

func closedShiftReceipt(id, outletID string, closingCash float64, closedAt time.Time) api.Shift {
	return api.Shift{
		Id: parseUUIDLoose(id), OutletId: parseUUIDLoose(outletID),
		Status:      api.ShiftStatusClosed,
		ClosedAt:    nullable.NewNullableWithValue(closedAt),
		ClosingCash: nullable.NewNullableWithValue(float32(closingCash)),
	}
}

// parseUUIDLoose never panics: a malformed id yields the zero UUID (receipts are
// built from ids that already came from the database or the verified JWT).
func parseUUIDLoose(s string) uuid.UUID {
	u, _ := uuid.Parse(s)
	return u
}
