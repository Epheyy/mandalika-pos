package main

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

func (s *server) hookDocuments(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	docs := append([]docRecord{}, s.st.Documents...)
	s.mu.Unlock()
	writeOK(w, http.StatusOK, docs)
}

func (s *server) hookBalances(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	rows := make([]balance, 0, len(s.st.Balances))
	for _, b := range s.st.Balances {
		rows = append(rows, *b)
	}
	s.mu.Unlock()
	sort.Slice(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.LocationType != b.LocationType {
			return a.LocationType < b.LocationType
		}
		if a.LocationSlug != b.LocationSlug {
			return a.LocationSlug < b.LocationSlug
		}
		return a.FgCode < b.FgCode
	})
	writeOK(w, http.StatusOK, rows)
}

func (s *server) hookFault(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status, count := http.StatusServiceUnavailable, 1
	var ds []detail
	if q.Has("status") {
		n, err := strconv.Atoi(q.Get("status"))
		if err != nil || n < 400 || n > 599 {
			ds = append(ds, detail{"status", "must be an integer between 400 and 599"})
		}
		status = n
	}
	if q.Has("count") {
		n, err := strconv.Atoi(q.Get("count"))
		if err != nil || n < 0 || n > 1000 {
			ds = append(ds, detail{"count", "must be an integer between 0 and 1000"})
		}
		count = n
	}
	if len(ds) > 0 {
		writeValidation(w, ds)
		return
	}
	s.fmu.Lock()
	s.faultStatus, s.faultLeft = status, count
	s.fmu.Unlock()
	writeOK(w, http.StatusOK, map[string]int{"status": status, "remaining": count})
}

func (s *server) hookUpsertFG(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	var in erpapi.IntegrationFG
	if err != nil || json.Unmarshal(body, &in) != nil {
		writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "malformed JSON body", nil)
		return
	}
	if ds := validateFGInput(&in); len(ds) > 0 {
		writeValidation(w, ds)
		return
	}
	if in.Gender == "" {
		in.Gender = erpapi.UNISEX
	}
	if in.Status == "" {
		in.Status = erpapi.ACTIVE
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, fg := range s.st.FinishedGoods {
		if fg.Code == in.Code && fg.Slug != in.Slug {
			writeValidation(w, []detail{{"code", "already used by slug " + fg.Slug}})
			return
		}
	}
	rec := in
	now := s.now().UTC()
	rec.UpdatedAt, rec.CreatedAt = now, now
	idx := -1
	for i, fg := range s.st.FinishedGoods {
		if fg.Slug == in.Slug {
			idx, rec.CreatedAt = i, fg.CreatedAt
		}
	}
	err = s.commitLocked(func() {
		if idx >= 0 {
			s.st.FinishedGoods[idx] = rec
		} else {
			s.st.FinishedGoods = append(s.st.FinishedGoods, rec)
		}
	})
	if err != nil {
		writeErr(w, http.StatusServiceUnavailable, "INTEGRATION_BUSY", "could not persist state, retry", nil)
		return
	}
	writeOK(w, http.StatusOK, rec)
}

func validateFGInput(in *erpapi.IntegrationFG) []detail {
	var ds []detail
	for path, v := range map[string]string{"slug": in.Slug, "code": in.Code, "name": in.Name} {
		if v == "" {
			ds = append(ds, detail{path, "is required"})
		}
	}
	if in.Gender != "" && !in.Gender.Valid() {
		ds = append(ds, detail{"gender", "invalid gender"})
	}
	if in.Status != "" && !in.Status.Valid() {
		ds = append(ds, detail{"status", "invalid status"})
	}
	return ds
}
