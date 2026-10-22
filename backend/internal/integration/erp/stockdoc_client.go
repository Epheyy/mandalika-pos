package erp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	stockDocumentsPath   = "/stock-documents"
	defaultClientTimeout = 10 * time.Second
	maxResponseBytes     = 64 << 10
	maxRetryAfter        = time.Hour
)

// Response is the raw ERP answer; classification happens in the relay.
type Response struct {
	Status     int
	Body       []byte
	RetryAfter time.Duration
}

// Poster sends one frozen stock document. A non-nil error means no HTTP answer.
type Poster interface {
	PostStockDocument(ctx context.Context, documentID string, body []byte) (Response, error)
}

// StockDocClient is a thin typed client for the one endpoint the relay needs (the generated
// erpapi package has no stock-documents operation).
type StockDocClient struct {
	baseURL, apiKey string
	http            *http.Client
}

// NewStockDocClient takes the ERP API base URL including its prefix (for example
// https://erp.example.com/api/integration/v1); timeout 0 means 10s. One attempt per
// call: retries and backoff belong to the relay state machine.
func NewStockDocClient(baseURL, apiKey string, timeout time.Duration) *StockDocClient {
	if timeout <= 0 {
		timeout = defaultClientTimeout
	}
	return &StockDocClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: timeout},
	}
}

// PostStockDocument sends body byte for byte with the document id as Idempotency-Key.
func (c *StockDocClient) PostStockDocument(ctx context.Context, documentID string, body []byte) (Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+stockDocumentsPath, bytes.NewReader(body))
	if err != nil {
		return Response{}, c.scrub(err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Idempotency-Key", documentID)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mandalika-pos-relay")

	resp, err := c.http.Do(req)
	if err != nil {
		return Response{}, c.scrub(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return Response{}, c.scrub(err)
	}
	return Response{
		Status:     resp.StatusCode,
		Body:       data,
		RetryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), time.Now()),
	}, nil
}

// scrub returns an error that cannot carry the API key. net/http errors normally hold
// only the URL, but the message is rebuilt defensively and the cause is not wrapped.
func (c *StockDocClient) scrub(err error) error {
	var uerr *url.Error
	msg := err.Error()
	if errors.As(err, &uerr) {
		msg = fmt.Sprintf("%s %s: %v", uerr.Op, c.baseURL+stockDocumentsPath, uerr.Err)
	}
	if c.apiKey != "" {
		msg = strings.ReplaceAll(msg, c.apiKey, "[redacted]")
	}
	return errors.New("erp: post stock document: " + msg)
}

// parseRetryAfter reads integer seconds or an HTTP-date, clamped to [0, 1h].
func parseRetryAfter(v string, now time.Time) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	var d time.Duration
	if secs, err := strconv.ParseInt(v, 10, 64); err == nil {
		if secs > int64(maxRetryAfter/time.Second) {
			return maxRetryAfter
		}
		d = time.Duration(secs) * time.Second
	} else if t, err := http.ParseTime(v); err == nil {
		d = t.Sub(now)
	}
	return min(max(d, 0), maxRetryAfter)
}
