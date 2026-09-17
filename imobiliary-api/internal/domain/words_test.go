package domain

import "testing"

func TestNumberInWords(t *testing.T) {
	for n, want := range map[int64]string{
		0:             "zero",
		1:             "um",
		14:            "quatorze",
		21:            "vinte e um",
		100:           "cem",
		101:           "cento e um",
		110:           "cento e dez",
		200:           "duzentos",
		999:           "novecentos e noventa e nove",
		1000:          "mil",
		1001:          "mil e um",
		1050:          "mil e cinquenta",
		1100:          "mil e cem",
		1567:          "mil quinhentos e sessenta e sete",
		1600:          "mil e seiscentos",
		2035:          "dois mil e trinta e cinco",
		10000:         "dez mil",
		100000:        "cem mil",
		123456:        "cento e vinte e três mil quatrocentos e cinquenta e seis",
		1000000:       "um milhão",
		1200000:       "um milhão e duzentos mil",
		2000001:       "dois milhões e um",
		3500250:       "três milhões quinhentos mil duzentos e cinquenta",
		1000000000:    "um bilhão",
		1234567891011: "um trilhão duzentos e trinta e quatro bilhões quinhentos e sessenta e sete milhões oitocentos e noventa e um mil e onze",
	} {
		if got := NumberInWords(n, false); got != want {
			t.Errorf("NumberInWords(%d) = %q, want %q", n, got, want)
		}
	}
	for n, want := range map[int64]string{1: "uma", 2: "duas", 12: "doze", 22: "vinte e duas", 200: "duzentas", 301: "trezentas e uma"} {
		if got := NumberInWords(n, true); got != want {
			t.Errorf("feminine %d = %q, want %q", n, got, want)
		}
	}
}

func TestMoneyInWords(t *testing.T) {
	for cents, want := range map[Money]string{
		0:            "zero reais",
		1:            "um centavo",
		50:           "cinquenta centavos",
		100:          "um real",
		150:          "um real e cinquenta centavos",
		160000:       "mil e seiscentos reais",
		480000:       "quatro mil e oitocentos reais",
		220333:       "dois mil duzentos e três reais e trinta e três centavos",
		100000000:    "um milhão de reais",
		120000000:    "um milhão e duzentos mil reais",
		300000000:    "três milhões de reais",
		100000000001: "um bilhão de reais e um centavo",
	} {
		if got := MoneyInWords(cents); got != want {
			t.Errorf("MoneyInWords(%d) = %q, want %q", cents, got, want)
		}
	}
}

func TestRateAndCountText(t *testing.T) {
	for r, want := range map[Rate]string{
		100_000: "10% (dez por cento)",
		10_000:  "1% (um por cento)",
		15_000:  "1,5% (um vírgula cinco por cento)",
		10_500:  "1,05% (um vírgula zero cinco por cento)",
		5_000:   "0,5% (zero vírgula cinco por cento)",
	} {
		if got := PercentText(r); got != want {
			t.Errorf("PercentText(%d) = %q, want %q", r, got, want)
		}
	}
	if got := CountText(3, false); got != "03 (três)" {
		t.Errorf("CountText(3) = %q", got)
	}
	if got := CountText(12, true); got != "12 (doze)" {
		t.Errorf("CountText(12, feminine) = %q", got)
	}
	if got := CountText(2, true); got != "02 (duas)" {
		t.Errorf("CountText(2, feminine) = %q", got)
	}
}

func TestMoneyAndDateText(t *testing.T) {
	for m, want := range map[Money]string{5: "R$ 0,05", 160000: "R$ 1.600,00", 123456789: "R$ 1.234.567,89"} {
		if got := MoneyText(m); got != want {
			t.Errorf("MoneyText(%d) = %q, want %q", m, got, want)
		}
	}
	d := DateInMonth(2026, 9, 7)
	if DateText(d) != "07/09/2026" || DateLongText(d) != "7 de setembro de 2026" || MonthYearText(d) != "setembro/2026" {
		t.Errorf("dates: %q %q %q", DateText(d), DateLongText(d), MonthYearText(d))
	}
}
