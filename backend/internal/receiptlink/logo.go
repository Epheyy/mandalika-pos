package receiptlink

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	logoHost       = "res.cloudinary.com"
	logoTransform  = "c_limit,w_360,h_112,f_png/" // 2x of the 180x56 CSS box; never crops or upscales
	logoMaxBytes   = 256 << 10
	logoFetchLimit = 3 * time.Second
	logoOKTTL      = time.Hour
	logoFailTTL    = 5 * time.Minute
)

// LogoCache fetches the brand logo once, server side, and serves it as a data: URI so the page
// stays one self-contained response (the CSP allows img-src data: only) and the customer's phone
// never contacts the image host. It remembers the one current source. Every method of a nil
// *LogoCache is safe and answers "".
type LogoCache struct {
	prefix string // allowed source prefix; "" = every source is rejected
	client *http.Client
	now    func() time.Time

	sf      singleflight.Group
	mu      sync.Mutex
	src     string
	val     template.URL
	expires time.Time
}

// NewLogoCache allows only https://res.cloudinary.com/<cloudName>/image/upload/ sources; an empty
// cloudName rejects every source.
func NewLogoCache(cloudName string) *LogoCache {
	c := &LogoCache{
		client: &http.Client{
			Timeout:       logoFetchLimit,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		now: time.Now,
	}
	if cloudName != "" {
		c.prefix = "https://" + logoHost + "/" + cloudName + "/image/upload/"
	}
	return c
}

// allowedLogoSource is the source check: https, exactly the allowed host (no userinfo, no port),
// no query or fragment, under the allowed path prefix, no dot-dot segments.
func allowedLogoSource(src, prefix string) bool {
	if prefix == "" || !strings.HasPrefix(src, prefix) || len(src) == len(prefix) {
		return false
	}
	p, err := url.Parse(prefix)
	if err != nil {
		return false
	}
	u, err := url.Parse(src)
	if err != nil || u.Scheme != "https" || u.Host != p.Host || u.User != nil {
		return false
	}
	if u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(src, "#") {
		return false
	}
	if !strings.HasPrefix(u.Path, p.Path) || strings.Contains(strings.ToLower(u.EscapedPath()), "%2e") {
		return false
	}
	for _, seg := range strings.Split(u.Path, "/") {
		if seg == ".." {
			return false
		}
	}
	return true
}

// Peek is the current cached value without any I/O ("" on a cold instance or after the logo was
// cleared). The 404, 429 and 503 pages use it, so they never read the database or fetch.
func (c *LogoCache) Peek() template.URL {
	if c == nil {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.val
}

// DataURI returns the logo of src as a data: URI, "" when src is empty, rejected or the fetch
// fails. Success is cached for an hour, failure for five minutes; a new src fetches at once.
func (c *LogoCache) DataURI(ctx context.Context, src string) template.URL {
	if c == nil {
		return ""
	}
	if !allowedLogoSource(src, c.prefix) {
		c.store("", "", time.Time{})
		return ""
	}
	if v, ok := c.cached(src); ok {
		return v
	}
	// Detached from this request's cancellation: the shared result must not depend on one caller.
	res, _, _ := c.sf.Do(src, func() (any, error) {
		v := c.fetch(context.WithoutCancel(ctx), src)
		ttl := logoOKTTL
		if v == "" {
			ttl = logoFailTTL
		}
		c.store(src, v, c.now().Add(ttl))
		return v, nil
	})
	v, _ := res.(template.URL)
	return v
}

func (c *LogoCache) cached(src string) (template.URL, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.src == src && c.now().Before(c.expires) {
		return c.val, true
	}
	return "", false
}

func (c *LogoCache) store(src string, v template.URL, expires time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.src, c.val, c.expires = src, v, expires
}

// fetch downloads the resized logo and returns it as a data: URI ("" on any failure, logged once).
func (c *LogoCache) fetch(ctx context.Context, src string) template.URL {
	v, err := c.download(ctx, c.prefix+logoTransform+src[len(c.prefix):])
	if err != nil {
		slog.Warn("receipt logo fetch failed", "reason", err.Error())
		return ""
	}
	return v
}

func (c *LogoCache) download(ctx context.Context, target string) (template.URL, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return "", errors.New("request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, logoMaxBytes+1))
	if err != nil {
		return "", errors.New("read failed")
	}
	if len(body) > logoMaxBytes {
		return "", errors.New("body too large")
	}
	typ := http.DetectContentType(body)
	if typ != "image/png" && typ != "image/jpeg" && typ != "image/webp" {
		return "", fmt.Errorf("content type %s", typ)
	}
	// html/template would rewrite a data: src to #ZgotmplZ; this is a sniffed raster image in base64.
	return template.URL("data:" + typ + ";base64," + base64.StdEncoding.EncodeToString(body)), nil
}
