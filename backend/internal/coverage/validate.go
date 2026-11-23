package coverage

import (
	"strings"

	"github.com/mandalika/pos-backend/internal/apperr"
)

// Validation refusals. They are domain errors (apperr.Rejected) whose text is shown to the
// admin verbatim, so an API handler answers them with 400.
var (
	ErrCashierOneOutlet     = apperr.New(apperr.Rejected, "Kasir harus ditempatkan di tepat satu outlet.")
	ErrManagerNeedsCoverage = apperr.New(apperr.Rejected, "Manajer perlu Semua Outlet atau minimal satu outlet.")
	ErrHomeNotCovered       = apperr.New(apperr.Rejected, "Outlet utama harus termasuk outlet yang dicakup.")
	ErrAdminNoCoverage      = apperr.New(apperr.Rejected, "Admin tidak memakai daftar outlet.")
	ErrAllWithHome          = apperr.New(apperr.Rejected, "Semua Outlet tidak bisa digabung dengan outlet utama.")
)

// Validate checks the MERGED state of a user (role, home outlet, full coverage list with the
// home first, all-outlets flag) before it is written, so the database CHECK
// users_all_outlets_no_home can never surface as a server error. A cashier is valid with a
// home and an empty or [home] list; an unknown role is not this function's concern.
func Validate(role, home string, outletIDs []string, allOutlets bool) error {
	switch role {
	case "admin":
		if allOutlets || len(withoutHome(home, outletIDs)) > 0 {
			return ErrAdminNoCoverage
		}
	case "cashier":
		if home == "" || allOutlets || len(withoutHome(home, outletIDs)) > 0 {
			return ErrCashierOneOutlet
		}
	case "manager":
		if allOutlets {
			if home != "" || len(outletIDs) > 0 {
				return ErrAllWithHome
			}
			return nil
		}
		if home == "" {
			return ErrManagerNeedsCoverage
		}
		if len(outletIDs) > 0 && !contains(outletIDs, home) {
			return ErrHomeNotCovered
		}
	}
	return nil
}

func contains(ids []string, id string) bool {
	for _, have := range ids {
		if strings.EqualFold(have, id) {
			return true
		}
	}
	return false
}

// withoutHome returns ids minus the home outlet (case-insensitive), never nil.
func withoutHome(home string, ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if home == "" || !strings.EqualFold(id, home) {
			out = append(out, id)
		}
	}
	return out
}

// Extras is the list stored in user_outlets for a merged state: the covered outlets minus
// the home. Only a manager with a home and without all-outlets keeps any; never nil.
func Extras(role, home string, outletIDs []string, allOutlets bool) []string {
	if role != "manager" || allOutlets || home == "" {
		return []string{}
	}
	return merge("", withoutHome(home, outletIDs))
}
