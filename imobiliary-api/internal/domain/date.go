package domain

import (
	"errors"
	"time"
)

// ErrInvalidDate is reported for a calendar date that does not exist or is not
// written as YYYY-MM-DD.
var ErrInvalidDate = errors.New("invalid date")

// dateLayout is how a Date is written, in JSON and anywhere else.
const dateLayout = "2006-01-02"

// Date is a day on the calendar, with no time and no zone.
//
// A birth date, a signature, a due date: none of them is an instant. Storing
// one as midnight in São Paulo makes it the previous day for every reader in
// UTC, which is how off-by-one bugs in contracts are born. A Date is compared
// and stored as the three numbers it is, and becomes an instant only when
// something asks which day it is "today" somewhere, through DateOf.
//
// The zero value is not a valid date; optional dates are held as *Date.
type Date struct {
	year  int
	month time.Month
	day   int
}

// NewDate builds a date, rejecting one that does not exist, such as 30
// February, and years outside 1 to 9999.
func NewDate(year int, month time.Month, day int) (Date, error) {
	if year < 1 || year > 9999 || month < time.January || month > time.December ||
		day < 1 || day > DaysIn(year, month) {
		return Date{}, ErrInvalidDate
	}
	return Date{year: year, month: month, day: day}, nil
}

// DateInMonth builds the date for a day in a given month, moving a day the
// month lacks to its last day: day 31 of April is 30 April, day 30 of
// February is the 28th or 29th. This is the rule for a due day that a month
// does not have.
func DateInMonth(year int, month time.Month, day int) Date {
	if last := DaysIn(year, month); day > last {
		day = last
	}
	if day < 1 {
		day = 1
	}
	return Date{year: year, month: month, day: day}
}

// DateOf is the calendar date of an instant as seen in a location.
func DateOf(t time.Time, loc *time.Location) Date {
	y, m, d := t.In(loc).Date()
	return Date{year: y, month: m, day: d}
}

// ParseDate reads a date written as YYYY-MM-DD.
func ParseDate(s string) (Date, error) {
	if len(s) != len(dateLayout) {
		return Date{}, ErrInvalidDate
	}
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return Date{}, ErrInvalidDate
	}
	return NewDate(t.Date())
}

// DaysIn is the number of days in a month.
func DaysIn(year int, month time.Month) int {
	// Day 0 of the next month is the last day of this one.
	return time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

// Year, Month and Day return the date's parts.
func (d Date) Year() int         { return d.year }
func (d Date) Month() time.Month { return d.month }
func (d Date) Day() int          { return d.day }

// IsZero reports whether d is the zero value.
func (d Date) IsZero() bool { return d == Date{} }

// Compare returns -1, 0 or +1 as d is before, equal to or after other.
func (d Date) Compare(other Date) int {
	switch {
	case d.year != other.year:
		return cmpInt(d.year, other.year)
	case d.month != other.month:
		return cmpInt(int(d.month), int(other.month))
	default:
		return cmpInt(d.day, other.day)
	}
}

// Before and After compare two dates.
func (d Date) Before(other Date) bool { return d.Compare(other) < 0 }
func (d Date) After(other Date) bool  { return d.Compare(other) > 0 }

// AddMonths moves the date by whole months, keeping its day where the target
// month has it and using the month's last day where it does not.
func (d Date) AddMonths(n int) Date {
	total := d.year*12 + int(d.month) - 1 + n
	return DateInMonth(total/12, time.Month(total%12+1), d.day)
}

// AddDays moves the date by whole days.
func (d Date) AddDays(n int) Date {
	return DateOf(d.Time().AddDate(0, 0, n), time.UTC)
}

// DaysUntil is the number of days from d to other, negative when other is
// earlier.
func (d Date) DaysUntil(other Date) int {
	return int(other.Time().Sub(d.Time()).Hours() / 24)
}

// Time is the date as midnight UTC, the form a database driver exchanges for a
// date column. It is not "the start of the day" anywhere in particular.
func (d Date) Time() time.Time {
	return time.Date(d.year, d.month, d.day, 0, 0, 0, 0, time.UTC)
}

// String writes the date as YYYY-MM-DD.
func (d Date) String() string {
	if d.IsZero() {
		return ""
	}
	return d.Time().Format(dateLayout)
}

// MarshalText makes a date a JSON string. The zero value has no text form.
func (d Date) MarshalText() ([]byte, error) {
	if d.IsZero() {
		return nil, ErrInvalidDate
	}
	return []byte(d.String()), nil
}

// UnmarshalText reads a JSON string with ParseDate.
func (d *Date) UnmarshalText(b []byte) error {
	v, err := ParseDate(string(b))
	if err != nil {
		return err
	}
	*d = v
	return nil
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	default:
		return 0
	}
}
