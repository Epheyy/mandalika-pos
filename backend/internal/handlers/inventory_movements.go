package handlers

import (
	"context"
	"encoding/csv"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/csvimport"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/read"
)

const (
	movementDefaultLimit = 50
	movementMaxLimit     = 200
	// Kartu stok export caps (plan §3): the range and the row count.
	movementExportMaxDays = 93
	movementExportMaxRows = 100000
	// A 100k-row export outlives the server's defaults (see ExportStockMovements).
	movementExportTimeout       = 55 * time.Second
	movementExportWriteDeadline = 60 * time.Second
	movementSkuLimit            = 8
)

var movementKinds = map[string]bool{
	"sale": true, "refund": true, "transfer_out": true, "transfer_in": true, "transfer_cancel": true,
	"receipt": true, "adjust": true, "count": true, "opening": true, "write_off": true,
}

// movementLocationAllowed is the explicit location check of the kartu stok reads. An admin
// reads every location whatever outlet the X-Outlet-Id switcher selected (like the other
// inventory reads). Anyone else reaches only their own outlet, plus warehouses: those have no
// outlet binding and are permission-gated (manage_inventory), as for stock counts.
func movementLocationAllowed(r *http.Request, locType, locID string) bool {
	if role, _ := r.Context().Value(auth.CtxRole).(string); role == "admin" {
		return true
	}
	if locType == "warehouse" {
		return true
	}
	sc := scope(r)
	return sc.CrossAll || (sc.OutletID != "" && strings.EqualFold(sc.OutletID, locID))
}

// parseMovementBound reads a from/to value: a calendar day in the location zone (a `to` day is
// inclusive, so it resolves to the next midnight) or an RFC 3339 instant ([from, to) as given).
func parseMovementBound(s string, zone *time.Location, isTo bool) (*time.Time, error) {
	if s == "" {
		return nil, nil
	}
	if d, err := time.ParseInLocation("2006-01-02", s, zone); err == nil {
		if isTo {
			d = d.AddDate(0, 0, 1)
		}
		return &d, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return nil, fmt.Errorf("tanggal tidak valid: %q", s)
	}
	return &t, nil
}

// movementLocation validates and scope-checks the location of a kartu stok read. It writes
// the error response itself and returns ok=false. The zone is the location's, for formatting.
func (h *Handlers) movementLocation(w http.ResponseWriter, r *http.Request) (locType, locID string, zone *time.Location, ok bool) {
	q := r.URL.Query()
	locType, locID = q.Get("locationType"), q.Get("locationId")
	if locType != "outlet" && locType != "warehouse" {
		httpx.Err(w, http.StatusBadRequest, "locationType harus outlet atau warehouse")
		return "", "", nil, false
	}
	if _, err := uuid.Parse(locID); err != nil {
		httpx.Err(w, http.StatusBadRequest, "locationId tidak valid")
		return "", "", nil, false
	}
	if !movementLocationAllowed(r, locType, locID) {
		httpx.Err(w, http.StatusForbidden, "lokasi di luar cakupan akun")
		return "", "", nil, false
	}
	zone, exists, err := h.Repo.LocationZone(r.Context(), locType, locID)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return "", "", nil, false
	}
	if !exists {
		httpx.Err(w, http.StatusNotFound, "lokasi tidak ditemukan")
		return "", "", nil, false
	}
	return locType, locID, zone, true
}

// movementFilter validates the query shared by the list, export and summary. It writes the error
// response itself and returns ok=false.
func (h *Handlers) movementFilter(w http.ResponseWriter, r *http.Request) (f read.MovementFilter, zone *time.Location, ok bool) {
	f.LocationType, f.LocationID, zone, ok = h.movementLocation(w, r)
	if !ok || !fillMovementOptions(w, r.URL.Query(), zone, &f) {
		return f, nil, false
	}
	if err := h.Repo.ResolveWindow(r.Context(), &f); err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return f, nil, false
	}
	return f, zone, true
}

func fillMovementOptions(w http.ResponseWriter, q url.Values, zone *time.Location, f *read.MovementFilter) bool {
	bad := func(msg string) bool { httpx.Err(w, http.StatusBadRequest, msg); return false }
	if p := q.Get("productId"); p != "" {
		if _, err := uuid.Parse(p); err != nil {
			return bad("productId tidak valid")
		}
		f.ProductID = p
	}
	f.VariantSize = q.Get("variantSize")
	if f.ProductID == "" && f.VariantSize != "" {
		return bad("variantSize memerlukan productId")
	}
	for _, k := range q["kind"] {
		if !movementKinds[k] {
			return bad("kind tidak dikenal: " + k)
		}
		f.Kinds = append(f.Kinds, k)
	}
	switch q.Get("flag") {
	case "":
	case "shortage":
		f.Shortage = true
	default:
		return bad("flag tidak dikenal")
	}
	if g := q.Get("giveaway"); g != "" {
		b, err := strconv.ParseBool(g)
		if err != nil {
			return bad("giveaway harus true atau false")
		}
		f.Giveaway = &b
	}
	var err error
	if f.From, err = parseMovementBound(q.Get("from"), zone, false); err != nil {
		return bad(err.Error())
	}
	if f.To, err = parseMovementBound(q.Get("to"), zone, true); err != nil {
		return bad(err.Error())
	}
	return true
}

// ListStockMovements serves the kartu stok page, newest first by seq (the saldo chain is
// continuous in seq order). `summary` is returned only for a single-SKU filter.
func (h *Handlers) ListStockMovements(w http.ResponseWriter, r *http.Request) {
	f, _, ok := h.movementFilter(w, r)
	if !ok {
		return
	}
	limit := movementDefaultLimit
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > movementMaxLimit {
			httpx.Err(w, http.StatusBadRequest, "limit harus 1-200")
			return
		}
		limit = n
	}
	var after int64
	if c := r.URL.Query().Get("cursor"); c != "" {
		seq, err := read.DecodeMovementCursor(c)
		if err != nil {
			httpx.Err(w, http.StatusBadRequest, "cursor tidak valid")
			return
		}
		after = seq
	}
	page := api.StockMovementPage{Data: []api.StockMovementRow{}}
	err := h.Repo.ForEachMovement(r.Context(), f, after, limit+1, func(m api.StockMovementRow) error {
		page.Data = append(page.Data, m)
		return nil
	})
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if len(page.Data) > limit {
		page.Data = page.Data[:limit]
		next := read.EncodeMovementCursor(page.Data[limit-1].Seq)
		page.NextCursor = &next
	}
	if f.SingleSKU() && after == 0 { // the saldo header belongs to the first page
		s, err := h.Repo.MovementSaldo(r.Context(), f)
		if err != nil {
			writeErr(w, r, http.StatusInternalServerError, err)
			return
		}
		page.Summary = &s
	}
	writeJSON(w, http.StatusOK, page)
}

// movementCSVHeader is the export header; the row order is the same as the list (seq DESC).
var movementCSVHeader = []string{"id", "waktu_kejadian", "waktu_tercatat", "jenis", "dokumen", "no_dokumen",
	"lokasi", "sku", "barcode", "produk", "ukuran", "masuk", "keluar", "saldo", "oleh", "alasan", "penyetuju", "tanda", "status_erp"}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// movementIsLate reports a movement recorded on a later business day than it occurred (an offline
// sale synced days after it was rung), reading both instants in the location zone.
func movementIsLate(m api.StockMovementRow, zone *time.Location) bool {
	const day = "2006-01-02"
	return m.OccurredAt.In(zone).Format(day) < m.RecordedAt.In(zone).Format(day)
}

func movementCSVRow(m api.StockMovementRow, zone *time.Location) []string {
	var in, out string
	if m.Qty > 0 {
		in = strconv.Itoa(m.Qty)
	} else if m.Qty < 0 {
		out = strconv.Itoa(-m.Qty)
	}
	var marks []string
	if m.IsGiveaway {
		marks = append(marks, "Hadiah")
	}
	for _, fl := range m.Flags {
		if fl == "shortage" {
			marks = append(marks, "Minus")
		}
	}
	if movementIsLate(m, zone) {
		marks = append(marks, "Tercatat terlambat")
	}
	g := csvimport.GuardCell
	return []string{m.Id.String(), m.OccurredAt.In(zone).Format(time.RFC3339), m.RecordedAt.In(zone).Format(time.RFC3339),
		string(m.Kind), m.RefType, g(deref(m.RefNumber)), g(deref(m.LocationName)), g(deref(m.Sku)), g(deref(m.Barcode)),
		g(deref(m.ProductName)), g(m.VariantSize), in, out, strconv.Itoa(m.QtyAfter),
		g(deref(m.ActorName)), g(deref(m.ReasonText)), g(deref(m.ApprovedBy)), strings.Join(marks, ";"), deref(m.ErpStatus)}
}

// ExportStockMovements is the kartu stok as CSV: same filters as the list, from and to required,
// at most 93 days and 100000 rows (413 above).
func (h *Handlers) ExportStockMovements(w http.ResponseWriter, r *http.Request) {
	f, zone, ok := h.movementFilter(w, r)
	if !ok {
		return
	}
	if f.From == nil || f.To == nil {
		httpx.Err(w, http.StatusBadRequest, "from dan to wajib untuk ekspor")
		return
	}
	if f.To.Sub(*f.From) > movementExportMaxDays*24*time.Hour {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "rentang ekspor maksimal 93 hari")
		return
	}
	n, err := h.Repo.CountMovements(r.Context(), f, movementExportMaxRows)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	if n > movementExportMaxRows {
		httpx.Err(w, http.StatusRequestEntityTooLarge, "ekspor melebihi 100000 baris; persempit filter")
		return
	}
	// A big export outlives the server's 30 s write timeout and the default request deadline (the
	// route is exempt from the deadline middleware): bound it here with its own context and extend
	// the write deadline slightly beyond it (best effort, ignored where unsupported).
	ctx, cancel := context.WithTimeout(r.Context(), movementExportTimeout)
	defer cancel()
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(movementExportWriteDeadline))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="kartu-stok.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write(movementCSVHeader)
	err = h.Repo.ForEachMovement(ctx, f, 0, 0, func(m api.StockMovementRow) error {
		return cw.Write(movementCSVRow(m, zone))
	})
	cw.Flush()
	if err == nil {
		err = cw.Error()
	}
	if err != nil {
		// The status line may already be sent, so a clean return would hand the client a 200 CSV
		// that is silently cut short. Abort the connection instead so the download fails (the
		// server recoverer treats http.ErrAbortHandler as a deliberate abort).
		slog.Error("stock movement export: aborted mid-stream", "err", err)
		panic(http.ErrAbortHandler)
	}
}

// LedgerMovementSummary is the per-SKU ledger summary (opening, in/out by kind, closing).
func (h *Handlers) LedgerMovementSummary(w http.ResponseWriter, r *http.Request) {
	f, _, ok := h.movementFilter(w, r)
	if !ok {
		return
	}
	p, l := pageLimit(r)
	rows, total, err := h.Repo.MovementLedgerSummary(r.Context(), f.Window, f.LocationType, f.LocationID,
		r.URL.Query().Get("q"), p, l)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.MovementLedgerSummaryResponse{Data: rows, Meta: *meta(total, p, l)})
}

// MovementSkus is the SKU picker of the kartu stok: variants matching q (name, SKU or barcode)
// that have at least one ledger row at the location. Cheap by design: it starts from the variant
// table and probes the ledger index, never scanning the location history.
func (h *Handlers) MovementSkus(w http.ResponseWriter, r *http.Request) {
	locType, locID, _, ok := h.movementLocation(w, r)
	if !ok {
		return
	}
	rows, err := h.Repo.MovementSkus(r.Context(), locType, locID, r.URL.Query().Get("q"), movementSkuLimit)
	if err != nil {
		writeErr(w, r, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, api.MovementSkuResponse{Data: rows})
}
