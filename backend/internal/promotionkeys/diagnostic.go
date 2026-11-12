package promotionkeys

import "encoding/json"

type StoredPromotion struct {
	ID           string          `json:"id"`
	Type         string          `json:"type"`
	IsActive     bool            `json:"isActive"`
	BundleConfig json.RawMessage `json:"bundleConfig"`
	BXGYConfig   json.RawMessage `json:"bxgyConfig"`
}

type Finding struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	IsActive   bool   `json:"isActive"`
	Reason     string `json:"reason"`
	LeftGroup  int    `json:"leftGroup"`
	RightGroup int    `json:"rightGroup"`
	LeftKey    string `json:"leftKey,omitempty"`
	RightKey   string `json:"rightKey,omitempty"`
}

// Diagnose reports semantic overlaps, including inactive legacy configs. It
// never edits a row and is not a complete mechanics/schema validity assessment.
// Unreadable configs are reported, not silently treated as overlap-free.
func Diagnose(p StoredPromotion) []Finding {
	var groups [][]string
	unreadable := func() []Finding {
		return []Finding{{ID: p.ID, Type: p.Type, IsActive: p.IsActive, Reason: "uninspectable_config", LeftGroup: -1, RightGroup: -1}}
	}
	switch p.Type {
	case "bundle":
		var c struct {
			Slots []struct {
				ProductKeys []string `json:"productKeys"`
			} `json:"slots"`
		}
		if json.Unmarshal(p.BundleConfig, &c) != nil || len(c.Slots) == 0 {
			return unreadable()
		}
		for _, s := range c.Slots {
			if len(s.ProductKeys) == 0 {
				return unreadable()
			}
			groups = append(groups, s.ProductKeys)
		}
	case "buy_x_get_y":
		var c *struct {
			Buy []string `json:"buyProductIds"`
			Get []string `json:"getProductIds"`
		}
		if json.Unmarshal(p.BXGYConfig, &c) != nil || c == nil {
			return unreadable()
		}
		groups = [][]string{c.Buy, c.Get}
	case "bundle_discount":
		// Matches bundles by ERP line and size, never by product key: nothing to overlap.
		return nil
	default:
		return nil
	}
	var findings []Finding
	for i, a := range groups {
		for j := i + 1; j < len(groups); j++ {
			for _, x := range a {
				for _, y := range groups[j] {
					if Overlap(x, y) {
						findings = append(findings, Finding{ID: p.ID, Type: p.Type, IsActive: p.IsActive, Reason: "semantic_overlap", LeftGroup: i, RightGroup: j, LeftKey: x, RightKey: y})
					}
				}
			}
		}
	}
	return findings
}
