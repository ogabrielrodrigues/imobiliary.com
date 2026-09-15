package domain

// A person's `identity` holds a CPF and a company's `registration` holds a
// CNPJ. The field names stay neutral, as the data model asks; the algorithms
// below carry the Brazilian names because that is what they are.

// NormalizeCPF reduces a CPF to its eleven digits and reports whether it is
// valid. Dots, a hyphen and spaces are accepted as formatting; any other
// character makes it invalid.
//
// The national identity card (CIN) uses the CPF as its number, which is why a
// person carries no separate identity document number.
func NormalizeCPF(s string) (string, bool) {
	digits, ok := stripFormatting(s, 11)
	if !ok || !allDigits(digits) || allSame(digits) {
		return "", false
	}
	if checkDigit(digits[:9], 10) != digits[9]-'0' || checkDigit(digits[:10], 11) != digits[10]-'0' {
		return "", false
	}
	return digits, true
}

// NormalizeCNPJ reduces a CNPJ to its fourteen characters, uppercased, and
// reports whether it is valid.
//
// Since July 2026 a CNPJ may be alphanumeric (IN RFB nº 2.229/2024): the first
// twelve positions take 0-9 or A-Z, and the two check digits stay numeric.
// Each character counts as its ASCII code minus 48, so a digit keeps its value
// and "A" counts as 17; the numeric CNPJs already issued remain valid under the
// same rule.
func NormalizeCNPJ(s string) (string, bool) {
	chars, ok := stripFormatting(s, 14)
	if !ok || allSame(chars) {
		return "", false
	}
	b := []byte(chars)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
			b[i] = c
		}
		isDigit := c >= '0' && c <= '9'
		if i >= 12 && !isDigit {
			return "", false
		}
		if !isDigit && (c < 'A' || c > 'Z') {
			return "", false
		}
	}
	chars = string(b)
	if cnpjCheckDigit(chars[:12]) != chars[12]-'0' || cnpjCheckDigit(chars[:13]) != chars[13]-'0' {
		return "", false
	}
	return chars, true
}

// FormatCPF writes normalised CPF digits as 000.000.000-00.
func FormatCPF(digits string) string {
	if len(digits) != 11 {
		return digits
	}
	return digits[:3] + "." + digits[3:6] + "." + digits[6:9] + "-" + digits[9:]
}

// FormatCNPJ writes a normalised CNPJ as 00.000.000/0000-00.
func FormatCNPJ(chars string) string {
	if len(chars) != 14 {
		return chars
	}
	return chars[:2] + "." + chars[2:5] + "." + chars[5:8] + "/" + chars[8:12] + "-" + chars[12:]
}

// checkDigit is the CPF check digit over digits, with weights counting down
// from firstWeight.
func checkDigit(digits string, firstWeight int) byte {
	sum := 0
	for i := 0; i < len(digits); i++ {
		sum += int(digits[i]-'0') * (firstWeight - i)
	}
	return elevenRemainder(sum)
}

// cnpjCheckDigit is the CNPJ check digit over chars, with weights running
// from 2 to 9 starting at the rightmost character and repeating.
func cnpjCheckDigit(chars string) byte {
	sum := 0
	weight := 2
	for i := len(chars) - 1; i >= 0; i-- {
		sum += int(chars[i]-'0') * weight
		weight++
		if weight > 9 {
			weight = 2
		}
	}
	return elevenRemainder(sum)
}

func elevenRemainder(sum int) byte {
	r := sum % 11
	if r < 2 {
		return 0
	}
	return byte(11 - r)
}

// stripFormatting removes the separators people type into tax numbers and
// reports whether exactly want characters remain.
func stripFormatting(s string, want int) (string, bool) {
	if len(s) > want+6 {
		return "", false
	}
	out := make([]byte, 0, want)
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '.', '-', '/', ' ':
		default:
			out = append(out, c)
		}
	}
	return string(out), len(out) == want
}

func allSame(s string) bool {
	for i := 1; i < len(s); i++ {
		if s[i] != s[0] {
			return false
		}
	}
	return true
}
