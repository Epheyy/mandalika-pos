package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

// TestGeneratedClientParsesStubResponses proves the erpapi client (what the
// catalog pull uses) decodes the stub's catalog and stock responses.
func TestGeneratedClientParsesStubResponses(t *testing.T) {
	e := newEnv(t, "")
	expectStatus(t, e.post(fixture(t, "doc_opening.json")), http.StatusOK)
	ts := httptest.NewServer(e.s)
	defer ts.Close()
	auth := erpapi.WithRequestEditorFn(func(_ context.Context, r *http.Request) error {
		r.Header.Set("Authorization", "Bearer "+testKey)
		return nil
	})
	c, err := erpapi.NewClientWithResponses(ts.URL+"/api/integration/v1", auth)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	take := 500
	fg, err := c.ListCatalogFinishedGoodsWithResponse(ctx, &erpapi.ListCatalogFinishedGoodsParams{Take: &take})
	if err != nil || fg.JSON200 == nil || len(fg.JSON200.Data.Items) == 0 {
		t.Fatalf("finished goods: err=%v status=%d body=%s", err, fg.StatusCode(), fg.Body)
	}
	out, err := c.ListCatalogOutletsWithResponse(ctx, &erpapi.ListCatalogOutletsParams{})
	if err != nil || out.JSON200 == nil || len(out.JSON200.Data.Items) == 0 {
		t.Fatalf("outlets: err=%v status=%d", err, out.StatusCode())
	}
	st, err := c.GetOutletStockWithResponse(ctx, "KMG", &erpapi.GetOutletStockParams{})
	if err != nil || st.JSON200 == nil || len(st.JSON200.Data.Items) != 1 || st.JSON200.Data.Items[0].Qty != 42 {
		t.Fatalf("stock: err=%v status=%d body=%s", err, st.StatusCode(), st.Body)
	}
}
