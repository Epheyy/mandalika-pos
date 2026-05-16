// Package uploads brokers signed Cloudinary uploads. The API secret stays
// server-side; the client uploads directly with the returned signature
// (plan §8 — replaces the legacy unsigned preset).
package uploads

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Signer struct {
	CloudName string
	APIKey    string
	APISecret string
}

type Signature struct {
	Timestamp int64  `json:"timestamp"`
	Signature string `json:"signature"`
	APIKey    string `json:"apiKey"`
	CloudName string `json:"cloudName"`
	Folder    string `json:"folder,omitempty"`
}

// Sign produces a Cloudinary upload signature for the given (optional) folder.
// signature = hex(sha1( sorted "k=v&..." of signed params + api_secret )).
func (s *Signer) Sign(folder string) (Signature, error) {
	if s.APISecret == "" || s.APIKey == "" || s.CloudName == "" {
		return Signature{}, fmt.Errorf("cloudinary not configured")
	}
	ts := time.Now().Unix()
	params := map[string]string{"timestamp": strconv.FormatInt(ts, 10)}
	if folder != "" {
		params["folder"] = folder
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+params[k])
	}
	h := sha1.New()
	h.Write([]byte(strings.Join(parts, "&") + s.APISecret))
	return Signature{
		Timestamp: ts,
		Signature: hex.EncodeToString(h.Sum(nil)),
		APIKey:    s.APIKey,
		CloudName: s.CloudName,
		Folder:    folder,
	}, nil
}
