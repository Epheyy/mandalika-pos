package erpstub

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

// outletCode mirrors the POS outlet code rule (2-20 upper-case letters, digits, inner hyphens).
var outletCode = regexp.MustCompile(`^[A-Z0-9][A-Z0-9-]{0,18}[A-Z0-9]$`)

// outletCreateRec remembers which Idempotency-Key created which outlet, to answer replays.
type outletCreateRec struct {
	ExternalID string `json:"external_id"`
	Hash       string `json:"hash"`
	Slug       string `json:"slug"`
}

type outletCreateBody struct {
	ExternalID string  `json:"external_id"`
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Address    *string `json:"address"`
	Phone      *string `json:"phone"`
}

// postOutlet is the stub of the proposed POST /outlets: idempotent create of one RETAIL
// outlet. Same key and body replays; same key with another body is CONFLICT; a code held
// by another outlet (case-insensitive), or an existing slug equal to the would-be slug,
// is OUTLET_CODE_TAKEN with details.slug.
func (s *Server) postOutlet(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	var in outletCreateBody
	if err != nil || json.Unmarshal(raw, &in) != nil {
		writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "malformed JSON body", nil)
		return
	}
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	var ds []detail
	if key == "" {
		ds = append(ds, detail{"Idempotency-Key", "is required"})
	} else if in.ExternalID != "" && in.ExternalID != key {
		ds = append(ds, detail{"external_id", "must equal the Idempotency-Key"})
	}
	in.Code = strings.ToUpper(strings.TrimSpace(in.Code))
	slug := strings.ToLower(in.Code)
	probe := erpapi.IntegrationOutlet{Slug: slug, Code: in.Code, Name: in.Name, Type: erpapi.IntegrationOutletType(in.Type)}
	ds = append(ds, validateOutletInput(&probe)...)
	if in.Code != "" && !outletCode.MatchString(in.Code) {
		ds = append(ds, detail{"code", "invalid outlet code"})
	}
	if len(ds) > 0 {
		writeValidation(w, ds)
		return
	}
	sum := sha256.Sum256(raw)
	hash := hex.EncodeToString(sum[:])

	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.st.OutletCreates {
		if c.ExternalID != key {
			continue
		}
		if c.Hash != hash {
			writeErr(w, http.StatusConflict, "CONFLICT", "Idempotency-Key was already used with a different body", nil)
			return
		}
		s.writeOutletOK(w, http.StatusOK, "replayed", c.Slug, in.Code)
		return
	}
	if o := s.st.findOutlet(func(o *erpapi.IntegrationOutlet) bool { return strings.EqualFold(o.Code, in.Code) || o.Slug == slug }); o != nil {
		writeJSON(w, http.StatusConflict, map[string]any{
			"success": false, "error": "Conflict", "message": "outlet code already used",
			"code": "OUTLET_CODE_TAKEN", "requestId": requestID(),
			"details": map[string]string{"slug": o.Slug},
		})
		return
	}
	now := s.now().UTC()
	rec := erpapi.IntegrationOutlet{
		Slug: slug, Code: in.Code, Name: in.Name, Type: erpapi.IntegrationOutletTypeRETAIL,
		Address: in.Address, Phone: in.Phone, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.commitLocked(func() {
		s.st.Outlets = append(s.st.Outlets, rec)
		s.st.OutletCreates = append(s.st.OutletCreates, outletCreateRec{key, hash, slug})
	}); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "INTEGRATION_BUSY", "could not persist state, retry", nil)
		return
	}
	s.writeOutletOK(w, http.StatusCreated, "applied", slug, in.Code)
}

func (s *Server) writeOutletOK(w http.ResponseWriter, status int, result, slug, code string) {
	data := map[string]any{"status": result, "outlet": map[string]string{"slug": slug, "code": code}}
	if s.erpEnv {
		writeJSON(w, status, map[string]any{"status": "success", "data": data})
		return
	}
	writeJSON(w, status, map[string]any{"success": true, "data": data})
}
