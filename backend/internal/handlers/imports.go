package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/mandalika/pos-backend/internal/api"
	"github.com/mandalika/pos-backend/internal/auth"
	"github.com/mandalika/pos-backend/internal/csvimport"
	"github.com/mandalika/pos-backend/internal/httpx"
	"github.com/mandalika/pos-backend/internal/write"
)

// importBodyCap bounds the JSON request (the CSV text itself is capped at 16 MiB inside
// csvimport.Read); anything larger is refused with an explicit 413.
const importBodyCap = 20 << 20

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

func (h *Handlers) runImport(w http.ResponseWriter, r *http.Request, kind string) {
	r.Body = http.MaxBytesReader(w, r.Body, importBodyCap)
	var body api.CsvImportRequest
	if err := httpx.Decode(r, &body); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			httpx.Err(w, http.StatusRequestEntityTooLarge, "file terlalu besar (maksimum 20 MiB)")
			return
		}
		httpx.Err(w, http.StatusBadRequest, "permintaan impor tidak valid")
		return
	}
	req := write.ImportRequest{Kind: kind, CSV: body.Csv, DryRun: body.DryRun}
	if body.FileName != nil {
		req.FileName = *body.FileName
	}
	if !body.DryRun {
		key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		if key == "" || len(key) > maxIdempotencyKey {
			httpx.Err(w, http.StatusBadRequest, "header Idempotency-Key wajib untuk menerapkan impor")
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
	req.UserID, _ = r.Context().Value(auth.CtxUserID).(string)

	res, err := h.Write.RunImport(r.Context(), req)
	if err != nil {
		slog.Error("csv import failed", "kind", kind, "err", err)
		httpx.Err(w, http.StatusInternalServerError, "impor gagal; tidak ada data yang diubah")
		return
	}
	switch res.Outcome {
	case write.ImportPreview, write.ImportReplay:
		httpx.JSON(w, http.StatusOK, res.Report)
	case write.ImportApplied:
		h.invalidate(r)
		httpx.JSON(w, http.StatusOK, res.Report)
	case write.ImportRejected:
		writeJSON(w, http.StatusUnprocessableEntity, httpx.Envelope{Data: res.Report,
			Error: "impor ditolak: perbaiki baris yang salah; tidak ada data yang diubah"})
	case write.ImportStale:
		writeJSON(w, http.StatusConflict, httpx.Envelope{Data: map[string]string{"code": "import_stale"},
			Error: "data berubah sejak pratinjau; pratinjau ulang sebelum menerapkan"})
	default: // ImportKeyConflict
		writeJSON(w, http.StatusConflict, httpx.Envelope{Data: map[string]string{"code": "idempotency_conflict"},
			Error: "kunci idempotensi ini sudah dipakai untuk file lain"})
	}
}
