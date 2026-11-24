package erp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const outletsPath = "/outlets"

// OutletCreate is one POS outlet to create in the ERP. The wire type is always RETAIL.
type OutletCreate struct {
	ExternalID, Code, Name string
	Address, Phone         *string
}

// OutletCreateResult is what the ERP answered for a created or replayed outlet.
type OutletCreateResult struct {
	Slug, Code string
	Replayed   bool
}

// OutletCreateOutcome classifies the ERP answer for the caller (the push step).
type OutletCreateOutcome int

const (
	OutletCreated         OutletCreateOutcome = iota // 2xx with a slug
	OutletCodeTaken                                  // 409 OUTLET_CODE_TAKEN
	OutletRejected                                   // any other 4xx, or an unusable 2xx
	OutletEndpointMissing                            // 404 / 405: the ERP has no such endpoint yet
	OutletUnavailable                                // 5xx, timeout, network error
)

// OutletCreator pushes one outlet. The error is non-nil only when ctx was cancelled;
// every ERP or network failure is an outcome plus a detail string for the run note.
type OutletCreator interface {
	CreateOutlet(ctx context.Context, in OutletCreate) (OutletCreateResult, OutletCreateOutcome, string, error)
}

// OutletCreateClient calls the proposed POST /outlets of the ERP integration API.
type OutletCreateClient struct {
	baseURL, apiKey string
	http            *http.Client
}

// NewOutletCreateClient takes the same base URL as NewStockDocClient (prefix included);
// timeout 0 means 10s. One attempt per call.
func NewOutletCreateClient(baseURL, apiKey string, timeout time.Duration) *OutletCreateClient {
	if timeout <= 0 {
		timeout = defaultClientTimeout
	}
	return &OutletCreateClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: timeout},
	}
}

type outletCreateWire struct {
	ExternalID string  `json:"external_id"`
	Code       string  `json:"code"`
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Address    *string `json:"address,omitempty"`
	Phone      *string `json:"phone,omitempty"`
}

// CreateOutlet sends the outlet with Idempotency-Key = ExternalID.
func (c *OutletCreateClient) CreateOutlet(ctx context.Context, in OutletCreate) (OutletCreateResult, OutletCreateOutcome, string, error) {
	body, err := json.Marshal(outletCreateWire{in.ExternalID, in.Code, in.Name, "RETAIL", in.Address, in.Phone})
	if err != nil {
		return OutletCreateResult{}, OutletRejected, "encode request: " + err.Error(), nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+outletsPath, bytes.NewReader(body))
	if err != nil {
		return OutletCreateResult{}, OutletUnavailable, c.scrub(err), nil
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Idempotency-Key", in.ExternalID)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "mandalika-pos-relay")

	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return OutletCreateResult{}, OutletUnavailable, "", ctx.Err()
		}
		return OutletCreateResult{}, OutletUnavailable, c.scrub(err), nil
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		if ctx.Err() != nil {
			return OutletCreateResult{}, OutletUnavailable, "", ctx.Err()
		}
		return OutletCreateResult{}, OutletUnavailable, c.scrub(err), nil
	}
	res, outcome, detail := decodeOutletCreate(resp.StatusCode, data)
	if c.apiKey != "" {
		detail = strings.ReplaceAll(detail, c.apiKey, "[redacted]")
	}
	return res, outcome, detail, nil
}

// scrub renders a transport error without the API key.
func (c *OutletCreateClient) scrub(err error) string {
	var uerr *url.Error
	msg := err.Error()
	if errors.As(err, &uerr) {
		msg = fmt.Sprintf("%s %s: %v", uerr.Op, c.baseURL+outletsPath, uerr.Err)
	}
	if c.apiKey != "" {
		msg = strings.ReplaceAll(msg, c.apiKey, "[redacted]")
	}
	return "erp: create outlet: " + msg
}

// decodeOutletCreate holds the whole guess about the (not yet existing) ERP contract, so
// adapting to the real one is an edit of this function only.
func decodeOutletCreate(status int, body []byte) (OutletCreateResult, OutletCreateOutcome, string) {
	var env struct {
		Success *bool  `json:"success"`
		Status  string `json:"status"`
		Code    string `json:"code"`
		Message string `json:"message"`
		Error   string `json:"error"`
		Data    struct {
			Status string `json:"status"`
			Slug   string `json:"slug"`
			Code   string `json:"code"`
			Outlet struct {
				Slug string `json:"slug"`
				Code string `json:"code"`
			} `json:"outlet"`
		} `json:"data"`
		Details json.RawMessage `json:"details"`
	}
	parsed := json.Unmarshal(body, &env) == nil
	errDetail := func() string {
		msg := env.Message
		if msg == "" {
			msg = env.Error
		}
		d := strings.TrimSpace(fmt.Sprintf("HTTP %d %s %s", status, env.Code, msg))
		return d
	}

	switch {
	case status >= 200 && status < 300:
		if !parsed || !successEnvelope(env.Success, env.Status) {
			return OutletCreateResult{}, OutletRejected, fmt.Sprintf("HTTP %d: unexpected response body", status)
		}
		slug, code := env.Data.Outlet.Slug, env.Data.Outlet.Code
		if slug == "" {
			slug, code = env.Data.Slug, env.Data.Code
		}
		if slug == "" {
			return OutletCreateResult{}, OutletRejected, fmt.Sprintf("HTTP %d: response has no outlet slug", status)
		}
		return OutletCreateResult{Slug: slug, Code: code, Replayed: env.Data.Status == "replayed"}, OutletCreated, ""
	case status == http.StatusNotFound || status == http.StatusMethodNotAllowed:
		return OutletCreateResult{}, OutletEndpointMissing, fmt.Sprintf("HTTP %d", status)
	case status == http.StatusConflict && env.Code == "OUTLET_CODE_TAKEN":
		var det struct {
			Slug string `json:"slug"`
		}
		_ = json.Unmarshal(env.Details, &det)
		if det.Slug == "" {
			det.Slug = "unknown"
		}
		return OutletCreateResult{}, OutletCodeTaken, "code taken by " + det.Slug
	case status >= 400 && status < 500:
		return OutletCreateResult{}, OutletRejected, errDetail()
	default:
		return OutletCreateResult{}, OutletUnavailable, errDetail()
	}
}
