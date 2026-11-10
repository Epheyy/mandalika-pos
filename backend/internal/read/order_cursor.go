package read

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// OrderCursor is the position of a keyset export page: the last row handed out and the
// asOf cut-off frozen by the first page. It carries no scope or filter: those always come
// from the token and the query string, so a forged cursor cannot widen access.
type OrderCursor struct {
	AsOf, CreatedAt time.Time
	ID              string
}

type cursorWire struct {
	V         int    `json:"v"`
	AsOf      string `json:"a"`
	CreatedAt string `json:"c"`
	ID        string `json:"i"`
}

// EncodeOrderCursor renders c as base64url JSON, times in RFC3339Nano (microsecond-exact).
func EncodeOrderCursor(c OrderCursor) string {
	raw, _ := json.Marshal(cursorWire{
		V:         1,
		AsOf:      c.AsOf.UTC().Format(time.RFC3339Nano),
		CreatedAt: c.CreatedAt.UTC().Format(time.RFC3339Nano),
		ID:        c.ID,
	})
	return base64.RawURLEncoding.EncodeToString(raw)
}

// DecodeOrderCursor is strict: version 1, RFC3339Nano times, a uuid, no unknown fields.
func DecodeOrderCursor(s string) (OrderCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return OrderCursor{}, ErrBadCursor
	}
	var w cursorWire
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&w); err != nil || w.V != 1 {
		return OrderCursor{}, ErrBadCursor
	}
	asOf, err1 := time.Parse(time.RFC3339Nano, w.AsOf)
	created, err2 := time.Parse(time.RFC3339Nano, w.CreatedAt)
	if err1 != nil || err2 != nil {
		return OrderCursor{}, ErrBadCursor
	}
	if u, err := uuid.Parse(w.ID); err != nil || u.String() != w.ID {
		return OrderCursor{}, ErrBadCursor
	}
	return OrderCursor{AsOf: asOf, CreatedAt: created, ID: w.ID}, nil
}
