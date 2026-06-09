package read

import "time"

// dayKey pairs an MMDD value (month*100+day) with how many days from "today"
// it is — used by Reminders to sort soonest-first and label "dalam N hari".
type dayKey struct {
	mmdd      int
	daysUntil int
}

func isLeap(y int) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

// mmddWindow returns the MMDD keys for the (days+1) calendar days starting at
// today (inclusive), soonest-first. AddDate handles month rollover and year-end
// wrap. In a non-leap year a window spanning Mar 1 also emits 0229 so Feb-29
// dates still get a reminder. days is clamped to [0, 366].
func mmddWindow(today time.Time, days int) []dayKey {
	if days < 0 {
		days = 0
	}
	if days > 366 {
		days = 366
	}
	out := make([]dayKey, 0, days+2)
	for i := 0; i <= days; i++ {
		d := today.AddDate(0, 0, i)
		out = append(out, dayKey{mmdd: int(d.Month())*100 + d.Day(), daysUntil: i})
		if d.Month() == time.March && d.Day() == 1 && !isLeap(d.Year()) {
			out = append(out, dayKey{mmdd: 229, daysUntil: i})
		}
	}
	return out
}
