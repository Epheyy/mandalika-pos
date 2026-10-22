package erp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mandalika/pos-backend/internal/integration/erp/erpapi"
)

const (
	defaultTimeout      = 10 * time.Second
	defaultMaxAttempts  = 3
	defaultMaxRetryWait = 10 * time.Second
	defaultRetryWait    = time.Second
	// MaxTake is the largest page size the ERP accepts; PageRequest.Take 0 means this.
	MaxTake = 500

	maxFgCodes      = 100      // contract: fg_codes holds 1..100 codes
	maxFgCodesChars = 1900     // contract: and at most 1900 characters
	maxBodyBytes    = 16 << 20 // a 500-item page is well under 1 MiB
)

// ErrERPNotFound matches (errors.Is) an APIError with HTTP 404 AND the ERP's
// NOT_FOUND code. A bare 404 (wrong base URL, route missing during an ERP
// deploy) is deliberately not ErrERPNotFound, so it can never read as "deleted".
var ErrERPNotFound = errors.New("erp: not found")

// APIError is a non-2xx answer from the ERP. It carries only the error code,
// message and request id, never request headers or the raw body.
type APIError struct {
	Status    int
	Code      string
	Message   string
	RequestID string
	// RetryAfter is the wait the ERP asked for on a 429/503 that was not retried
	// (attempts exhausted, or the wait exceeds MaxRetryWait); 0 otherwise.
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("erp: HTTP %d", e.Status)
	if e.Code != "" {
		s += " " + e.Code
	}
	if e.Message != "" {
		s += ": " + e.Message
	}
	if e.RequestID != "" {
		s += " (requestId " + e.RequestID + ")"
	}
	return s
}

// Is reports ErrERPNotFound for a 404 carrying the ERP's NOT_FOUND code.
func (e *APIError) Is(target error) bool {
	return target == ErrERPNotFound && e.Status == http.StatusNotFound && e.Code == "NOT_FOUND"
}

// ClientOptions configures NewClient. Zero values take the documented defaults.
type ClientOptions struct {
	BaseURL      string // ERP_BASE_URL, including /api/integration/v1
	APIKey       string // bearer key; never logged or put in an error
	HTTPClient   *http.Client
	MaxAttempts  int           // total attempts per call on 429/503 (default 3)
	MaxRetryWait time.Duration // longest Retry-After honoured in-process (default 10s); a longer one fails the call
	// Sleep waits d or returns ctx.Err(); tests inject a recorder.
	Sleep func(ctx context.Context, d time.Duration) error
}

// Client is the read-only ERP Integration API client. Safe for concurrent use.
type Client struct {
	api          *erpapi.ClientWithResponses
	maxAttempts  int
	maxRetryWait time.Duration
	sleep        func(ctx context.Context, d time.Duration) error
}

// PageRequest selects one catalog page. A nil UpdatedSince is a full sync; on
// incremental runs follow-up pages must repeat UpdatedSince together with Cursor.
type PageRequest struct {
	UpdatedSince *time.Time
	Cursor       *string
	Take         int // 0 => MaxTake
}

// Page is one decoded catalog page; NextCursor nil marks the last page.
type Page[T any] struct {
	Items      []T
	NextCursor *string
	ServerTime time.Time
}

// NewClient builds a Client. BaseURL and APIKey are required.
func NewClient(o ClientOptions) (*Client, error) {
	if strings.TrimSpace(o.BaseURL) == "" {
		return nil, errors.New("erp: base URL is required")
	}
	if o.APIKey == "" {
		return nil, errors.New("erp: API key is required")
	}
	hc := o.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: defaultTimeout}
	}
	key := o.APIKey
	api, err := erpapi.NewClientWithResponses(strings.TrimRight(o.BaseURL, "/"),
		erpapi.WithHTTPClient(hc),
		erpapi.WithRequestEditorFn(func(_ context.Context, req *http.Request) error {
			req.Header.Set("Authorization", "Bearer "+key)
			req.Header.Set("Accept", "application/json")
			return nil
		}))
	if err != nil {
		return nil, fmt.Errorf("erp: invalid base URL: %w", err)
	}
	c := &Client{api: api, maxAttempts: o.MaxAttempts, maxRetryWait: o.MaxRetryWait, sleep: o.Sleep}
	if c.maxAttempts < 1 {
		c.maxAttempts = defaultMaxAttempts
	}
	if c.maxRetryWait <= 0 {
		c.maxRetryWait = defaultMaxRetryWait
	}
	if c.sleep == nil {
		c.sleep = sleepCtx
	}
	return c, nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// FinishedGoodsPage fetches one page of the finished-goods catalog.
func (c *Client) FinishedGoodsPage(ctx context.Context, r PageRequest) (Page[erpapi.IntegrationFG], error) {
	p := &erpapi.ListCatalogFinishedGoodsParams{UpdatedSince: utcPtr(r.UpdatedSince), Cursor: r.Cursor, Take: takePtr(r.Take)}
	resp, err := c.exec(ctx, func() (*http.Response, error) { return c.api.ListCatalogFinishedGoods(ctx, p) })
	if err != nil {
		return Page[erpapi.IntegrationFG]{}, err
	}
	out, err := erpapi.ParseListCatalogFinishedGoodsResponse(resp)
	if err != nil {
		return Page[erpapi.IntegrationFG]{}, fmt.Errorf("erp: decode finished goods page: %w", err)
	}
	if out.JSON200 == nil {
		return Page[erpapi.IntegrationFG]{}, undecodable(out.StatusCode())
	}
	d := out.JSON200.Data
	return Page[erpapi.IntegrationFG]{Items: d.Items, NextCursor: d.NextCursor, ServerTime: d.ServerTime}, nil
}

// OutletsPage fetches one page of the outlet catalog.
func (c *Client) OutletsPage(ctx context.Context, r PageRequest) (Page[erpapi.IntegrationOutlet], error) {
	p := &erpapi.ListCatalogOutletsParams{UpdatedSince: utcPtr(r.UpdatedSince), Cursor: r.Cursor, Take: takePtr(r.Take)}
	resp, err := c.exec(ctx, func() (*http.Response, error) { return c.api.ListCatalogOutlets(ctx, p) })
	if err != nil {
		return Page[erpapi.IntegrationOutlet]{}, err
	}
	out, err := erpapi.ParseListCatalogOutletsResponse(resp)
	if err != nil {
		return Page[erpapi.IntegrationOutlet]{}, fmt.Errorf("erp: decode outlet page: %w", err)
	}
	if out.JSON200 == nil {
		return Page[erpapi.IntegrationOutlet]{}, undecodable(out.StatusCode())
	}
	d := out.JSON200.Data
	return Page[erpapi.IntegrationOutlet]{Items: d.Items, NextCursor: d.NextCursor, ServerTime: d.ServerTime}, nil
}

// OutletStock reads the stock of the outlet with the given (admin-mutable) code.
// With fgCodes it is a single call (the contract forbids take/cursor then);
// otherwise it follows next_cursor to the end.
func (c *Client) OutletStock(ctx context.Context, code string, fgCodes []string) ([]erpapi.IntegrationOutletStockItem, error) {
	joined := strings.Join(fgCodes, ",")
	if len(fgCodes) > maxFgCodes || len(joined) > maxFgCodesChars {
		return nil, fmt.Errorf("erp: at most %d fg codes and %d characters per stock call", maxFgCodes, maxFgCodesChars)
	}
	var items []erpapi.IntegrationOutletStockItem
	var cursor *string
	seen := map[string]bool{}
	for {
		p := &erpapi.GetOutletStockParams{}
		if len(fgCodes) > 0 {
			p.FgCodes = &joined
		} else {
			p.Take, p.Cursor = takePtr(0), cursor
		}
		resp, err := c.exec(ctx, func() (*http.Response, error) { return c.api.GetOutletStock(ctx, code, p) })
		if err != nil {
			return nil, err
		}
		out, err := erpapi.ParseGetOutletStockResponse(resp)
		if err != nil {
			return nil, fmt.Errorf("erp: decode outlet stock: %w", err)
		}
		if out.JSON200 == nil {
			return nil, undecodable(out.StatusCode())
		}
		items = append(items, out.JSON200.Data.Items...)
		cursor = out.JSON200.Data.NextCursor
		if len(fgCodes) > 0 || cursor == nil {
			return items, nil
		}
		if err := checkCursor(seen, *cursor); err != nil {
			return nil, err
		}
	}
}

// FindOutletCodeBySlug pages the full outlet catalog for the slug's current code.
func (c *Client) FindOutletCodeBySlug(ctx context.Context, slug string) (code string, found bool, err error) {
	var cursor *string
	seen := map[string]bool{}
	for {
		pg, err := c.OutletsPage(ctx, PageRequest{Cursor: cursor})
		if err != nil {
			return "", false, err
		}
		for _, o := range pg.Items {
			if o.Slug == slug {
				return o.Code, true, nil
			}
		}
		if pg.NextCursor == nil {
			return "", false, nil
		}
		if err := checkCursor(seen, *pg.NextCursor); err != nil {
			return "", false, err
		}
		cursor = pg.NextCursor
	}
}

// OutletStockBySlug reads outlet stock by its stored code and, when the ERP
// answers 404 (code renamed), re-resolves the code from the stable slug and
// retries once. currentCode is the code that worked; the caller persists it
// when it changed. A slug that is gone (or whose code is unchanged) returns the
// original ErrERPNotFound.
func (c *Client) OutletStockBySlug(ctx context.Context, slug, knownCode string, fgCodes []string) (items []erpapi.IntegrationOutletStockItem, currentCode string, err error) {
	items, err = c.OutletStock(ctx, knownCode, fgCodes)
	if err == nil {
		return items, knownCode, nil
	}
	if !errors.Is(err, ErrERPNotFound) {
		return nil, knownCode, err
	}
	code, found, ferr := c.FindOutletCodeBySlug(ctx, slug)
	if errors.Is(ferr, ErrERPNotFound) {
		// The catalog endpoint never 404s by contract; never let this read as "outlet gone".
		return nil, knownCode, fmt.Errorf("erp: resolving outlet code by slug: %s", ferr)
	}
	if ferr != nil {
		return nil, knownCode, fmt.Errorf("erp: resolving outlet code by slug: %w", ferr)
	}
	if !found || code == knownCode {
		return nil, knownCode, err
	}
	items, err = c.OutletStock(ctx, code, fgCodes)
	if err != nil {
		return nil, knownCode, err
	}
	return items, code, nil
}

// exec sends the request, retrying 429/503 after Retry-After, and returns a
// 2xx response whose body is buffered again for the generated Parse* helper.
// Any other status is an *APIError (the status survives an undecodable error
// body). Network errors and ctx cancellation are returned wrapped, not retried.
func (c *Client) exec(ctx context.Context, send func() (*http.Response, error)) (*http.Response, error) {
	for attempt := 1; ; attempt++ {
		resp, err := send()
		if err != nil {
			return nil, fmt.Errorf("erp: request failed: %w", err)
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
		_ = resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("erp: read response: %w", err)
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			resp.Body = io.NopCloser(bytes.NewReader(body))
			return resp, nil
		}
		apiErr := newAPIError(resp.StatusCode, body)
		if resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode != http.StatusServiceUnavailable {
			return nil, apiErr
		}
		wait, ok := c.retryWait(resp.Header.Get("Retry-After"))
		apiErr.RetryAfter = wait
		// A wait longer than MaxRetryWait (e.g. RATE_LIMIT_BLOCKED) is honoured by
		// failing now: retrying early inside an IP block can prolong it.
		if !ok || attempt >= c.maxAttempts {
			return nil, apiErr
		}
		if err := c.sleep(ctx, wait); err != nil {
			return nil, fmt.Errorf("erp: waiting to retry: %w", err)
		}
	}
}

// retryWait parses Retry-After (delta-seconds or HTTP-date); missing, negative
// or invalid means 1s. ok is false when the ERP asks for longer than
// maxRetryWait (the returned wait is then only for reporting).
func (c *Client) retryWait(h string) (wait time.Duration, ok bool) {
	h = strings.TrimSpace(h)
	if secs, err := strconv.ParseInt(h, 10, 64); err == nil || errors.Is(err, strconv.ErrRange) {
		switch {
		case err != nil || secs > int64(c.maxRetryWait/time.Second):
			return c.maxRetryWait, false // compared before multiplying: no Duration overflow
		case secs >= 0:
			return time.Duration(secs) * time.Second, true
		}
		return defaultRetryWait, true
	}
	if t, err := http.ParseTime(h); err == nil {
		d := max(time.Until(t), 0)
		return d, d <= c.maxRetryWait
	}
	return defaultRetryWait, true
}

// checkCursor fails a paging loop on a repeated next_cursor (an ERP bug would
// otherwise loop until the caller's deadline).
func checkCursor(seen map[string]bool, cursor string) error {
	if seen[cursor] {
		return errors.New("erp: the ERP repeated a page cursor")
	}
	seen[cursor] = true
	return nil
}

func newAPIError(status int, body []byte) *APIError {
	e := &APIError{Status: status}
	var env struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(body, &env) == nil && (env.Code != "" || env.Message != "") {
		e.Code, e.Message, e.RequestID = env.Code, env.Message, env.RequestID
		return e
	}
	e.Message = http.StatusText(status)
	return e
}

func undecodable(status int) error {
	return fmt.Errorf("erp: HTTP %d with an undecodable success body", status)
}

func utcPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

func takePtr(n int) *int {
	if n <= 0 || n > MaxTake {
		n = MaxTake
	}
	return &n
}
