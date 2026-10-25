package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/csvimport"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

// importBodyCap bounds the JSON request (the CSV text itself is capped at 16 MiB inside
// csvimport.Read); anything larger is refused with an explicit 413.
const importBodyCap = 20 << 20

// ImportBodyCap is exported so the server body-limit table reuses the number.
const ImportBodyCap int64 = importBodyCap

const maxIdempotencyKey = 200

// ImportCustomers, ImportProducts and ImportIngredients share one flow: dry run
// (preview, nothing written) or commit (Idempotency-Key + the preview's hash and
// summary, all-or-nothing). Permission is enforced by the route group.
func (h *Handlers) ImportCustomers(w http.ResponseWriter, r *http.Request) {
	h.runImport(w, r, csvimport.KindCustomers)
}

func (h *Handlers) ImportProducts(w http.ResponseWriter, r *http.Request) {
	h.runImport(w, r, csvimport.KindProducts)
}

func (h *Handlers) ImportIngredients(w http.ResponseWriter, r *http.Request) {
	h.runImport(w, r, csvimport.KindIngredients)
}

// maxConcurrentImports caps import requests (preview or commit) running at once in this
// process; Cloud Run gives 512 MiB and one 50k-row preview holds several copies of the file.
const maxConcurrentImports = 2

// defaultImportSlots serves a Handlers value built without New (nil importSlots).
var defaultImportSlots = make(chan struct{}, maxConcurrentImports)

// The server's global timeouts (ReadTimeout 15s, WriteTimeout 30s) are far too short for a
// 16 MiB upload plus a 50k-row plan, so these routes alone extend their own deadlines.
const (
	importReadWindow  = 60 * time.Second
	importWriteWindow = 150 * time.Second
)

const (
	importSlotRetryAfterSeconds = 5 // another import holds a slot; imports take seconds
	importBusyRetryAfterSeconds = 2 // lock conflict, nothing applied
)

// answerImportBusy answers a lock conflict (write.ErrBusy) as a retryable 503 and
// reports whether it did.
func answerImportBusy(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, write.ErrBusy) {
		return false
	}
	w.Header().Set("Retry-After", strconv.Itoa(importBusyRetryAfterSeconds))
	httpx.Err(w, http.StatusServiceUnavailable, "sibuk, coba lagi (proses lain sedang memakai data yang sama); tidak ada data yang diubah")
	return true
}

// beginImport takes an import slot, extends the route's deadlines and caps the body. The returned
// release must be deferred; ok=false means the response was already written.
func (h *Handlers) beginImport(w http.ResponseWriter, r *http.Request) (release func(), ok bool) {
	slots := h.importSlots
	if slots == nil { // a Handlers built without New still gets the default limit
		slots = defaultImportSlots
	}
	select {
	case slots <- struct{}{}:
		release = func() { <-slots }
	default:
		w.Header().Set("Retry-After", strconv.Itoa(importSlotRetryAfterSeconds))
		httpx.Err(w, http.StatusTooManyRequests, "sibuk, coba lagi sebentar (impor lain sedang berjalan)")
		return nil, false
	}
	rc := http.NewResponseController(w)
	for name, set := range map[string]func(time.Time) error{"read": rc.SetReadDeadline, "write": rc.SetWriteDeadline} {
		window := importReadWindow
		if name == "write" {
			window = importWriteWindow
		}
		// A writer without deadline support (httptest) is expected; anything else is worth a log.
		if err := set(time.Now().Add(window)); err != nil && !errors.Is(err, http.ErrNotSupported) {
			slog.Warn("csv import: could not extend deadline", "which", name, "err", err)
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, importBodyCap)
	return release, true
}

// decodeImportBody reads the JSON request; a refused body is answered here (ok=false).
func decodeImportBody[T any](w http.ResponseWriter, r *http.Request) (body T, ok bool) {
	if err := httpx.Decode(r, &body); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.Err(w, http.StatusRequestEntityTooLarge, "file terlalu besar (maksimum 20 MiB)")
			return body, false
		}
		httpx.Err(w, http.StatusBadRequest, "permintaan impor tidak valid")
		return body, false
	}
	return body, true
}

// commitKey reads the Idempotency-Key a commit requires (answers 400 itself).
func commitKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" || len(key) > maxIdempotencyKey {
		httpx.Err(w, http.StatusBadRequest, "header Idempotency-Key wajib untuk menerapkan impor")
		return "", false
	}
	return key, true
}

func (h *Handlers) runImport(w http.ResponseWriter, r *http.Request, kind string) {
	release, ok := h.beginImport(w, r)
	if !ok {
		return
	}
	defer release()
	body, ok := decodeImportBody[api.CsvImportRequest](w, r)
	if !ok {
		return
	}
	req := write.ImportRequest{Kind: kind, CSV: body.Csv, DryRun: body.DryRun}
	if body.FileName != nil {
		req.FileName = *body.FileName
	}
	if !body.DryRun {
		key, ok := commitKey(w, r)
		if !ok {
			return
		}
		if body.FileSha256 == nil || *body.FileSha256 == "" || body.ExpectedSummary == nil {
			httpx.Err(w, http.StatusBadRequest, "fileSha256 dan expectedSummary dari pratinjau wajib untuk menerapkan impor")
			return
		}
		req.Key, req.FileSHA256 = key, *body.FileSha256
		req.Expected = &csvimport.Summary{
			Create: body.ExpectedSummary.Create, Update: body.ExpectedSummary.Update,
			Skip: body.ExpectedSummary.Skip, Error: body.ExpectedSummary.Error,
			Warning: body.ExpectedSummary.Warning, NewCategories: body.ExpectedSummary.NewCategories,
		}
	}
	h.finishImport(w, r, req)
}

// finishImport runs a built request and answers every outcome.
func (h *Handlers) finishImport(w http.ResponseWriter, r *http.Request, req write.ImportRequest) {
	kind := req.Kind
	req.UserID, _ = r.Context().Value(auth.CtxUserID).(string)

	run := h.Write.RunImport
	if h.importRunner != nil {
		run = h.importRunner
	}
	res, err := run(r.Context(), req)
	if answerImportBusy(w, err) {
		return
	}
	if write.IsStockGuardRefusal(err) {
		// D13: a rename of a stocked variant that a stale preview let through; nothing applied.
		httpx.Err(w, http.StatusConflict, safeDomainText(r, http.StatusConflict, err))
		return
	}
	if kind == csvimport.KindStockCount {
		if errors.Is(err, write.ErrNotFound) {
			writeErr(w, r, http.StatusNotFound, err)
			return
		}
		if countConflict(w, r, err) { // the count is not in progress
			return
		}
	}
	if err != nil {
		slog.Error("csv import failed", "kind", kind, "err", err)
		httpx.Err(w, http.StatusInternalServerError, "impor gagal; tidak ada data yang diubah")
		return
	}
	switch res.Outcome {
	case write.ImportPreview, write.ImportReplay:
		httpx.JSON(w, http.StatusOK, reportOf(res))
	case write.ImportApplied:
		h.invalidate(r)
		httpx.JSON(w, http.StatusOK, reportOf(res))
	case write.ImportRejected:
		writeJSON(w, http.StatusUnprocessableEntity, httpx.Envelope{Data: reportOf(res),
			Error: "impor ditolak: perbaiki baris yang salah; tidak ada data yang diubah"})
	case write.ImportStale:
		writeJSON(w, http.StatusConflict, httpx.Envelope{Data: map[string]string{"code": "import_stale"},
			Error: "data berubah sejak pratinjau; pratinjau ulang sebelum menerapkan"})
	default: // ImportKeyConflict
		writeJSON(w, http.StatusConflict, httpx.Envelope{Data: map[string]string{"code": "idempotency_conflict"},
			Error: "kunci idempotensi ini sudah dipakai untuk file lain"})
	}
}

// reportOf is the report a response carries: the count report for a stock count import.
func reportOf(res write.ImportResult) any {
	if res.Count != nil {
		return res.Count
	}
	return res.Report
}
