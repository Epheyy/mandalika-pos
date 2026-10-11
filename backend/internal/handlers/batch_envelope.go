package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"

	syncpkg "github.com/mandalika/pos-backend/internal/sync"
)

var errBatchEnvelope = errors.New("invalid body")

// Read command-defining members before ordinary unmarshaling can discard a
// duplicate. Token unescaping and EqualFold preserve supported single aliases.
// Business payload bytes remain opaque for their per-command validators.
func batchObject(r io.Reader, consumed ...string) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(r)
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errBatchEnvelope
	}
	fields := make(map[string]json.RawMessage)
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return nil, errBatchEnvelope
		}
		key, ok := token.(string)
		if !ok {
			return nil, errBatchEnvelope
		}
		var raw json.RawMessage
		if d.Decode(&raw) != nil {
			return nil, errBatchEnvelope
		}
		for _, name := range consumed {
			if strings.EqualFold(key, name) {
				if _, exists := fields[name]; exists {
					return nil, errBatchEnvelope
				}
				fields[name] = raw
				break
			}
		}
	}
	if token, err = d.Token(); err != nil || token != json.Delim('}') {
		return nil, errBatchEnvelope
	}
	var tail json.RawMessage
	if d.Decode(&tail) != io.EOF {
		return nil, errBatchEnvelope
	}
	return fields, nil
}

// Complete the entire structural pass before returning anything to dispatch.
// Historical absent/null/empty items remain no-op batches. An item without a
// usable original key cannot be safely correlated, so reject its envelope.
func decodeBatchEnvelope(r io.Reader) ([]syncpkg.BatchItem, error) {
	fields, err := batchObject(r, "items")
	if err != nil {
		return nil, err
	}
	raw, exists := fields["items"]
	if !exists {
		return nil, nil
	}
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil {
		return nil, errBatchEnvelope
	}
	items := make([]syncpkg.BatchItem, 0, len(entries))
	for _, entry := range entries {
		fields, err := batchObject(bytes.NewReader(entry), "type", "idempotencyKey", "payload", "envelope")
		if err != nil {
			return nil, err
		}
		var item syncpkg.BatchItem
		if raw, ok := fields["type"]; ok && json.Unmarshal(raw, &item.Type) != nil {
			return nil, errBatchEnvelope
		}
		if json.Unmarshal(fields["idempotencyKey"], &item.IdempotencyKey) != nil || strings.TrimSpace(item.IdempotencyKey) == "" {
			return nil, errBatchEnvelope
		}
		// Do not trim/rekey captured identity, or normalize payload content.
		item.Payload = fields["payload"]
		// The capture-time envelope (A04) rides as an opaque sibling of payload; it is
		// parsed and verified per item in sync.attribute so one malformed envelope
		// fails that item (actor_mismatch), not the whole batch. JSON null = absent.
		if raw, ok := fields["envelope"]; ok && string(bytes.TrimSpace(raw)) != "null" {
			item.Envelope = raw
		}
		items = append(items, item)
	}
	return items, nil
}
