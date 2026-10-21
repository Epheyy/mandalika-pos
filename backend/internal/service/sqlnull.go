package service

import (
	"encoding/json"
	"log/slog"
)

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullNum(n float64) any {
	if n == 0 {
		return nil
	}
	return n
}

// nullBytes returns nil for empty raw JSON so a $N::jsonb param stores SQL NULL
// instead of failing to parse an empty string.
func nullBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

// nullCodes marshals applied code strings to a jsonb array, or NULL when empty.
func nullCodes(codes []string) any {
	if len(codes) == 0 {
		return nil
	}
	b, err := json.Marshal(codes)
	if err != nil {
		// M1: surface the error so it is not silently swallowed (per repo policy).
		// json.Marshal of []string cannot fail in practice, but log it if it ever does.
		slog.Error("marshal applied codes", "err", err)
		return nil
	}
	return b
}
