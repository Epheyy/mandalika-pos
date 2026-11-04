package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// A categoryId that is not a uuid is refused before the repository is touched (the list is never read), so the
// filter cannot reach SQL as free text. The filtered and unfiltered answers are covered by TestListParamsPostgres.
func TestIngredientsRejectsBadCategoryID(t *testing.T) {
	h := New(nil, nil, nil, nil, nil, nil, nil)
	for _, v := range []string{"not-a-uuid", "1", "00000000-0000-4000-8d03-00000000000z"} {
		r := httptest.NewRequest(http.MethodGet, "/ingredients?categoryId="+v, nil)
		w := httptest.NewRecorder()
		h.Ingredients(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("categoryId=%q: status %d, want 400", v, w.Code)
		}
	}
}
