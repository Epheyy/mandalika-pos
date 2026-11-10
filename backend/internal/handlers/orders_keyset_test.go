package handlers

import (
	"net/url"
	"testing"
	"time"

	"github.com/mandalika/pos-backend/internal/read"
)

func TestKeysetParamValidation(t *testing.T) {
	good := read.EncodeOrderCursor(read.OrderCursor{AsOf: time.Now(), CreatedAt: time.Now(), ID: "00000000-0000-4000-8603-000000000001"})
	cases := []struct {
		name    string
		query   string
		refund  bool
		wantErr bool
		limit   int
	}{
		{"defaults to 50", "paging=keyset", false, false, 50},
		{"limit 1000 ok", "paging=keyset&limit=1000", false, false, 1000},
		{"limit 1 ok", "paging=keyset&limit=1", false, false, 1},
		{"limit 1001 rejected, no clamp", "paging=keyset&limit=1001", false, true, 0},
		{"limit 0 rejected", "paging=keyset&limit=0", false, true, 0},
		{"limit text rejected", "paging=keyset&limit=abc", false, true, 0},
		{"cursor without paging", "cursor=" + good, false, true, 0},
		{"unknown paging", "paging=offset", false, true, 0},
		{"page 2 with paging", "paging=keyset&page=2", false, true, 0},
		{"page 1 with paging ok", "paging=keyset&page=1", false, false, 50},
		{"refund basis", "paging=keyset", true, true, 0},
		{"malformed cursor", "paging=keyset&cursor=garbage", false, true, 0},
		{"valid cursor", "paging=keyset&cursor=" + good + "&limit=200", false, false, 200},
	}
	for _, c := range cases {
		q, _ := url.ParseQuery(c.query)
		limit, _, msg := keysetParams(q, c.refund)
		if (msg != "") != c.wantErr {
			t.Errorf("%s: msg=%q wantErr=%v", c.name, msg, c.wantErr)
			continue
		}
		if !c.wantErr && limit != c.limit {
			t.Errorf("%s: limit %d want %d", c.name, limit, c.limit)
		}
	}
}
