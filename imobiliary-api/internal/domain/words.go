package domain

import (
	"fmt"
	"strconv"
	"strings"
)

// Numbers written out in Brazilian Portuguese, as contracts repeat amounts
// ("R$ 1.600,00 (mil e seiscentos reais)"). Written by hand: the rules are few
// and a dependency for them would be larger than the code.

var (
	wordsUnits = [...]string{"zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
		"dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"}
	wordsTens     = [...]string{"", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"}
	wordsHundreds = [...]string{"", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos",
		"setecentos", "oitocentos", "novecentos"}
)

// feminize turns the words that inflect ("um", "dois", "-entos") feminine.
func feminize(word string) string {
	switch {
	case word == "um":
		return "uma"
	case word == "dois":
		return "duas"
	case strings.HasSuffix(word, "entos") && word != "cento":
		return strings.TrimSuffix(word, "os") + "as"
	}
	return word
}

// belowThousand writes 1 to 999.
func belowThousand(n int64, feminine bool) string {
	var parts []string
	hundreds, rest := n/100, n%100
	switch {
	case n == 100:
		return "cem"
	case hundreds > 0:
		parts = append(parts, wordsHundreds[hundreds])
	}
	switch {
	case rest == 0:
	case rest < 20:
		parts = append(parts, wordsUnits[rest])
	default:
		tens, units := rest/10, rest%10
		if units == 0 {
			parts = append(parts, wordsTens[tens])
		} else {
			parts = append(parts, wordsTens[tens]+" e "+wordsUnits[units])
		}
	}
	if feminine {
		for i, p := range parts {
			words := strings.Split(p, " ")
			for j, w := range words {
				words[j] = feminize(w)
			}
			parts[i] = strings.Join(words, " ")
		}
	}
	return strings.Join(parts, " e ")
}

var wordsScales = [...]struct{ one, many string }{
	{"", ""},
	{"mil", "mil"},
	{"milhão", "milhões"},
	{"bilhão", "bilhões"},
	{"trilhão", "trilhões"},
}

// NumberInWords writes a whole number: 1600 is "mil e seiscentos", 1567 is
// "mil quinhentos e sessenta e sete". Feminine inflects what agrees with a
// feminine noun ("duas notas", "duzentas").
func NumberInWords(n int64, feminine bool) string {
	if n < 0 {
		return "menos " + NumberInWords(-n, feminine)
	}
	if n == 0 {
		return "zero"
	}
	var groups []int64
	for v := n; v > 0; v /= 1000 {
		groups = append(groups, v%1000)
	}
	if len(groups) > len(wordsScales) {
		return strconv.FormatInt(n, 10)
	}

	var parts []string
	lowest := -1
	for i, g := range groups {
		if g != 0 {
			lowest = i
			break
		}
	}
	for i := len(groups) - 1; i >= 0; i-- {
		g := groups[i]
		if g == 0 {
			continue
		}
		var text string
		switch {
		case i == 1 && g == 1:
			text = "mil" // never "um mil"
		case i == 0:
			text = belowThousand(g, feminine)
		case i == 1:
			text = belowThousand(g, feminine) + " mil"
		case g == 1:
			text = "um " + wordsScales[i].one
		default:
			text = belowThousand(g, false) + " " + wordsScales[i].many
		}
		// "e" joins the last group when it is below a hundred or a round
		// hundred: "mil e seiscentos", "mil e cinquenta", but "mil quinhentos
		// e sessenta".
		if len(parts) > 0 && i == lowest && (g < 100 || g%100 == 0) {
			text = "e " + text
		}
		parts = append(parts, text)
	}
	return strings.Join(parts, " ")
}

// MoneyInWords writes an amount in reais: "mil e seiscentos reais",
// "um real e cinquenta centavos", "um milhão de reais".
func MoneyInWords(m Money) string {
	v := int64(m)
	if v < 0 {
		return "menos " + MoneyInWords(Money(-v))
	}
	reais, cents := v/100, v%100
	var parts []string
	if reais > 0 || cents == 0 {
		unit := "reais"
		if reais == 1 {
			unit = "real"
		}
		words := NumberInWords(reais, false)
		// An exact million or more takes "de": "um milhão de reais".
		if reais >= 1_000_000 && reais%1_000_000 == 0 {
			unit = "de " + unit
		}
		parts = append(parts, words+" "+unit)
	}
	if cents > 0 {
		unit := "centavos"
		if cents == 1 {
			unit = "centavo"
		}
		parts = append(parts, NumberInWords(cents, false)+" "+unit)
	}
	return strings.Join(parts, " e ")
}

// RateInWords writes a percentage: "dez por cento", "um vírgula cinco por
// cento", "trinta e três vírgula três mil trezentos e trinta e três por cento".
func RateInWords(r Rate) string {
	text := r.String() // "10.00", "1.50", "-3.1812"
	negative := strings.HasPrefix(text, "-")
	text = strings.TrimPrefix(text, "-")
	whole, fraction, _ := strings.Cut(text, ".")
	fraction = strings.TrimRight(fraction, "0")
	w, _ := strconv.ParseInt(whole, 10, 64)
	out := NumberInWords(w, false)
	if fraction != "" {
		f, _ := strconv.ParseInt(fraction, 10, 64)
		// Leading zeros are read out: 1.05 is "um vírgula zero cinco".
		zeros := strings.Repeat("zero ", len(fraction)-len(strings.TrimLeft(fraction, "0")))
		out += " vírgula " + zeros + NumberInWords(f, false)
	}
	if negative {
		out = "menos " + out
	}
	return out + " por cento"
}

// PercentText is a rate as a contract writes it: "10% (dez por cento)".
func PercentText(r Rate) string {
	text := strings.TrimSuffix(strings.TrimRight(r.String(), "0"), ".")
	return fmt.Sprintf("%s%% (%s)", strings.ReplaceAll(text, ".", ","), RateInWords(r))
}

// MoneyNumberText is the amount without the currency: "1.600,00". A template
// that writes its own "R$" needs the number on its own.
func MoneyNumberText(m Money) string {
	return strings.TrimPrefix(strings.TrimPrefix(MoneyText(m), "-R$ "), "R$ ")
}

// RateNumberText is a rate without the sign or the words: "10", "2,5". A
// template that writes "%" itself needs the number on its own.
func RateNumberText(r Rate) string {
	text := strings.TrimSuffix(strings.TrimRight(r.String(), "0"), ".")
	return strings.ReplaceAll(text, ".", ",")
}

// CountText is a count as a contract writes it, two digits and the words:
// "03 (três)", "12 (doze)". Feminine agrees with the noun that follows.
func CountText(n int, feminine bool) string {
	return fmt.Sprintf("%02d (%s)", n, NumberInWords(int64(n), feminine))
}

var monthNames = [...]string{"janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto",
	"setembro", "outubro", "novembro", "dezembro"}

// MoneyText writes an amount as a contract shows it: "R$ 1.600,00".
func MoneyText(m Money) string {
	v := int64(m)
	sign := ""
	if v < 0 {
		sign, v = "-", -v
	}
	whole := strconv.FormatInt(v/100, 10)
	var groups []string
	for len(whole) > 3 {
		groups = append([]string{whole[len(whole)-3:]}, groups...)
		whole = whole[:len(whole)-3]
	}
	groups = append([]string{whole}, groups...)
	return fmt.Sprintf("%sR$ %s,%02d", sign, strings.Join(groups, "."), v%100)
}

// DateText writes a date as dd/mm/aaaa.
func DateText(d Date) string {
	if d.IsZero() {
		return ""
	}
	return fmt.Sprintf("%02d/%02d/%04d", d.Day(), int(d.Month()), d.Year())
}

// DateLongText writes a date as a signature line does: "17 de setembro de 2026".
func DateLongText(d Date) string {
	if d.IsZero() {
		return ""
	}
	return fmt.Sprintf("%d de %s de %d", d.Day(), monthNames[d.Month()-1], d.Year())
}

// MonthYearText writes the month of a date: "outubro/2026".
func MonthYearText(d Date) string {
	if d.IsZero() {
		return ""
	}
	return fmt.Sprintf("%s/%d", monthNames[d.Month()-1], d.Year())
}
