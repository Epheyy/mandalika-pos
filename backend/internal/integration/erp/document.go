package erp

// Wire shapes of POST /api/integration/v1/stock-documents (contract §4.3,
// docs/integration/stock-documents.v1.yaml). Only what the POS emits: the
// optional discount and customer_ref fields are left out on purpose.

// StockDocument is one stock document (or one part of a split document).
type StockDocument struct {
	DocumentID string           `json:"document_id"`
	Kind       string           `json:"kind"`
	Part       *DocumentPart    `json:"part,omitempty"`
	Source     DocumentSource   `json:"source"`
	Location   DocumentLocation `json:"location"`
	OccurredAt string           `json:"occurred_at"` // RFC3339 UTC, second precision
	RecordedAt string           `json:"recorded_at"` // RFC3339 UTC = erp_outbox.created_at
	Ref        DocumentRef      `json:"ref"`
	Lines      []StockLine      `json:"lines"`
	Tenders    []Tender         `json:"tenders,omitempty"`
}

// DocumentPart marks a document split at 200 lines (index 1..count).
type DocumentPart struct {
	Index int `json:"index"`
	Count int `json:"count"`
}

// DocumentSource names the system and brand that produced the document.
type DocumentSource struct {
	System   string `json:"system"`
	Brand    string `json:"brand"`
	DeviceID string `json:"device_id,omitempty"`
	Actor    string `json:"actor,omitempty"`
}

// DocumentLocation is the ERP slug of the outlet or warehouse.
type DocumentLocation struct {
	Type string `json:"type"`
	Slug string `json:"slug"`
}

// DocumentRef is the business document the movements belong to.
type DocumentRef struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Number string `json:"number,omitempty"`
}

// StockLine is one stock movement. Quantities are always emitted (zero is a
// valid value); Flags is never null.
type StockLine struct {
	MovementID         string   `json:"movement_id"`
	FgCode             string   `json:"fg_code"`
	Qty                int64    `json:"qty"`
	QtyBefore          int64    `json:"qty_before"`
	QtyAfter           int64    `json:"qty_after"`
	UnitPrice          *int64   `json:"unit_price,omitempty"`
	Reason             string   `json:"reason"`
	Flags              []string `json:"flags"`
	RefundOfMovementID string   `json:"refund_of_movement_id,omitempty"`
	ExpectedQty        *int64   `json:"expected_qty,omitempty"`
}

// Tender is a payment on a sale (negative on a refund).
type Tender struct {
	Method string `json:"method"`
	Amount int64  `json:"amount"`
}

// Result is the "data" member of the ERP's 200 response.
type Result struct {
	DocumentID  string   `json:"document_id"`
	Status      string   `json:"status"` // applied | replayed
	MovementIDs []string `json:"movement_ids"`
}

// ErrorBody is the ERP's error envelope.
type ErrorBody struct {
	Success   bool          `json:"success"`
	Error     string        `json:"error"`
	Message   string        `json:"message"`
	Code      string        `json:"code"`
	RequestID string        `json:"requestId"`
	Details   []ErrorDetail `json:"details"`
}

// ErrorDetail points at one invalid field.
type ErrorDetail struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}
