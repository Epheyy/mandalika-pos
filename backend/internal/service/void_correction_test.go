package service

import (
	"reflect"
	"testing"
)

func TestShiftCorrectionRows(t *testing.T) {
	orig := []tenderAmount{{"cash", 100000}, {"qris", 50000}}
	cases := []struct {
		name string
		orig []tenderAmount
		repl []tenderAmount
		want []shiftCorrection
	}{
		{"split to single", orig, []tenderAmount{{"qris", 150000}}, []shiftCorrection{
			{"void", "o", "cash", -100000}, {"void", "o", "qris", -50000}, {"replacement", "r", "qris", 150000}}},
		{"same method lines are summed", []tenderAmount{{"cash", 40000}, {"cash", 60000}}, nil,
			[]shiftCorrection{{"void", "o", "cash", -100000}}},
		{"repl nil gives only void rows", orig, nil, []shiftCorrection{
			{"void", "o", "cash", -100000}, {"void", "o", "qris", -50000}}},
		{"orig nil gives only replacement rows", nil, []tenderAmount{{"qris", 300000}},
			[]shiftCorrection{{"replacement", "r", "qris", 300000}}},
		{"zero sums dropped", []tenderAmount{{"cash", 0}}, []tenderAmount{{"qris", 5}, {"qris", -5}}, []shiftCorrection{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := shiftCorrectionRows("o", c.orig, "r", c.repl)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestCorrectionAmount(t *testing.T) {
	if got := correctionAmount(300000, 320000); got != -20000 {
		t.Fatalf("got %d", got)
	}
	if got := correctionAmount(300000, 300000); got != 0 {
		t.Fatalf("got %d", got)
	}
}
