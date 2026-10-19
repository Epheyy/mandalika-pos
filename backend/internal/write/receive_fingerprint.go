package write

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

// A08: pure helpers shared by the mint handler, the in-transaction consume and the
// sync redemption (sync imports write, so they live here).

// ReceiveFingerprint is the canonical sha256 of what the approver approved: the
// transfer, the counted lines (sorted, so order is irrelevant) and the trimmed
// discrepancy reason. Computed in Go only, at mint and at redemption.
func ReceiveFingerprint(transferID string, items []TransferReceiveItem, reason string) string {
	type line struct {
		P string `json:"p"`
		V string `json:"v"`
		Q int    `json:"q"`
	}
	lines := make([]line, len(items))
	for i, it := range items {
		lines[i] = line{it.ProductID, it.VariantSize, it.ReceivedQty}
	}
	sort.Slice(lines, func(i, j int) bool {
		if lines[i].P != lines[j].P {
			return lines[i].P < lines[j].P
		}
		if lines[i].V != lines[j].V {
			return lines[i].V < lines[j].V
		}
		return lines[i].Q < lines[j].Q
	})
	b, _ := json.Marshal(struct {
		T string `json:"t"`
		I []line `json:"i"`
		R string `json:"r"`
	}{transferID, lines, strings.TrimSpace(reason)})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// ApproverAllowed reports whether a role may approve a POS transfer receive.
// Admins always; others must be in approverRoles.
func ApproverAllowed(role string, approverRoles []string) bool {
	if role == "admin" {
		return true
	}
	for _, r := range approverRoles {
		if r == role {
			return true
		}
	}
	return false
}

// ReceiveScope checks the transfer's destination is the caller's outlet and the
// approver is an admin or belongs to that outlet. "" = ok. destOutlet "" means the
// destination is a warehouse.
func ReceiveScope(callerOutlet, destOutlet, approverRole, approverOutlet string) string {
	if destOutlet == "" || destOutlet != callerOutlet {
		return "transfer bukan untuk outlet ini"
	}
	if approverRole != "admin" && approverOutlet != destOutlet {
		return "tidak berwenang"
	}
	return ""
}
