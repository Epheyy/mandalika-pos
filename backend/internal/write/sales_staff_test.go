package write

import (
	"errors"
	"reflect"
	"testing"

	"github.com/mandalika/pos-backend/internal/coverage"
)

func TestPlanSalesStaffUpdate(t *testing.T) {
	const bsd, lwb, mks = "bsd", "lwb", "mks"
	str := func(s string) *string { return &s }
	partial := SalesStaffCaller{UserID: "m", Cov: coverage.Coverage{OutletIDs: []string{bsd}}}
	fullMgr := SalesStaffCaller{UserID: "m", Cov: coverage.Coverage{OutletIDs: []string{bsd, lwb}}}
	allMgr := SalesStaffCaller{UserID: "m", Cov: coverage.Coverage{All: true}}
	admin := SalesStaffCaller{UserID: "a", Admin: true}
	both := SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{bsd, lwb}}

	cases := []struct {
		name    string
		c       SalesStaffCaller
		cur, in SalesStaffInput
		want    SalesStaffInput
		wantErr error
	}{
		{"admin renames", admin, both, SalesStaffInput{Name: " Rini ", Active: true, OutletIDs: []string{bsd, lwb, mks}},
			SalesStaffInput{Name: "Rini", Active: true, OutletIDs: []string{bsd, lwb, mks}}, nil},
		{"all-outlets manager edits any", allMgr, both, SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{mks}},
			SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{mks}}, nil},
		{"full-cover manager deactivates", fullMgr, both, SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd, lwb}},
			SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd, lwb}}, nil},
		{"partial manager rename is forbidden", partial, both, SalesStaffInput{Name: "Rini", Active: true, OutletIDs: []string{bsd, lwb}},
			SalesStaffInput{}, ErrSalesStaffForbidden},
		{"partial manager nonaktif drops covered outlets only", partial, both, SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd, lwb}},
			SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{lwb}}, nil},
		{"partial manager adding an uncovered outlet is forbidden", partial, SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{bsd}},
			SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{bsd, lwb}}, SalesStaffInput{}, ErrSalesStaffForbidden},
		{"partial manager unticks BSD, LWB stays", partial, both, SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{lwb}},
			SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{lwb}}, nil},
		{"partial manager cannot reactivate", partial, SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd, lwb}},
			SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{bsd, lwb}}, SalesStaffInput{}, ErrSalesStaffForbidden},
		{"partial manager cannot relink", partial, both, SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{bsd, lwb}, UserID: str("u1")},
			SalesStaffInput{}, ErrSalesStaffForbidden},
		{"partial manager keeps the link when unchanged", partial, SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{bsd, lwb}, UserID: str("u1")},
			SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{lwb}, UserID: str("u1")},
			SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{lwb}, UserID: str("u1")}, nil},
		{"no covered outlet is not found", partial, SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{lwb}},
			SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{lwb}}, SalesStaffInput{}, ErrSalesStaffNotFound},
		{"full editor cannot empty the outlets", fullMgr, both, SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{}},
			SalesStaffInput{}, ErrSalesStaffInvalid},
		{"full editor cannot blank the name", admin, both, SalesStaffInput{Name: "  ", Active: true, OutletIDs: []string{bsd}},
			SalesStaffInput{}, ErrSalesStaffInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := planSalesStaffUpdate(tc.c, tc.cur, tc.in)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}
