package write

import (
	"errors"
	"reflect"
	"testing"

	"github.com/mandalika/pos-backend/internal/coverage"
)

func TestPlanSalesStaffUpdate(t *testing.T) {
	const bsd, bsd2, lwb, mks = "bsd", "bsd2", "lwb", "mks"
	str := func(s string) *string { return &s }
	partial := coverage.Caller{UserID: "m", Cov: coverage.Coverage{OutletIDs: []string{bsd}}}
	partial2 := coverage.Caller{UserID: "m", Cov: coverage.Coverage{OutletIDs: []string{bsd, bsd2}}}
	inactive3 := SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd, bsd2, lwb}}
	fullMgr := coverage.Caller{UserID: "m", Cov: coverage.Coverage{OutletIDs: []string{bsd, lwb}}}
	allMgr := coverage.Caller{UserID: "m", Cov: coverage.Coverage{All: true}}
	admin := coverage.Caller{UserID: "a", Admin: true}
	both := SalesStaffInput{Name: "Rina", Active: true, OutletIDs: []string{bsd, lwb}}

	cases := []struct {
		name    string
		c       coverage.Caller
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
		{"partial manager edits outlets of an inactive person", partial2, inactive3, SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd}},
			SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{lwb, bsd}}, nil},
		{"partial manager cannot add an unrelated outlet to an inactive person", partial2, inactive3, SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd, mks}},
			SalesStaffInput{}, ErrSalesStaffForbidden},
		{"partial manager ticks a covered outlet on an inactive person", partial2, SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{lwb, bsd}},
			SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd, bsd2}},
			SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{lwb, bsd, bsd2}}, nil},
		{"partial manager nonaktif with a trailing-space stored name", partial, SalesStaffInput{Name: "Rina ", Active: true, OutletIDs: []string{bsd, lwb}},
			SalesStaffInput{Name: "Rina", Active: false, OutletIDs: []string{bsd, lwb}},
			SalesStaffInput{Name: "Rina ", Active: true, OutletIDs: []string{lwb}}, nil},
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
