package domain

// The legal retention of an office's records about a person
// (PLANO-PENDENCIAS.md §4, PRIVACIDADE.md). The longest period that applies
// is the tax one: five years counted from the first day of the year after the
// last event (Código Tributário Nacional art. 173, I). The three years in which
// rents prescribe (Código Civil art. 206, §3º, I) end sooner.

// RetentionYears is the tax retention, in whole years.
const RetentionYears = 5

// RetentionEnds is the first day a record whose last event was on last may
// be anonymised: the first of January five years after the year following it.
func RetentionEnds(last Date) Date {
	return DateInMonth(last.Year()+1+RetentionYears, 1, 1)
}

// PastRetention reports whether a record whose last event was on last can be
// anonymised today.
func PastRetention(last, today Date) bool {
	return !today.Before(RetentionEnds(last))
}
