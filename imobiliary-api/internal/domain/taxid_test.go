package domain

import (
	"strings"
	"testing"
)

func TestNormalizeCPF(t *testing.T) {
	for in, want := range map[string]string{
		"529.982.247-25": "52998224725",
		"52998224725":    "52998224725",
		"529 982 247 25": "52998224725",
		"111.444.777-35": "11144477735",
	} {
		got, ok := NormalizeCPF(in)
		if !ok || got != want {
			t.Errorf("NormalizeCPF(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{
		"", "529.982.247-26", "529.982.247-15", "111.111.111-11", "000.000.000-00",
		"5299822472", "529982247250", "529.982.247_25", "52998224A25",
	} {
		if _, ok := NormalizeCPF(in); ok {
			t.Errorf("NormalizeCPF(%q) accepted an invalid CPF", in)
		}
	}
	if got := FormatCPF("52998224725"); got != "529.982.247-25" {
		t.Errorf("FormatCPF = %q", got)
	}
}

func TestNormalizeCNPJ(t *testing.T) {
	for in, want := range map[string]string{
		"11.222.333/0001-81": "11222333000181",
		"11222333000181":     "11222333000181",
		// The Receita Federal's own example of an alphanumeric CNPJ.
		"12.ABC.345/01DE-35": "12ABC34501DE35",
		"12.abc.345/01de-35": "12ABC34501DE35",
	} {
		got, ok := NormalizeCNPJ(in)
		if !ok || got != want {
			t.Errorf("NormalizeCNPJ(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{
		"", "11.222.333/0001-82", "12.ABC.345/01DE-36", "00.000.000/0000-00",
		"12.ABC.345/01DE-3A", "12.ABÇ.345/01DE-35", "1122233300018", "112223330001811",
	} {
		if _, ok := NormalizeCNPJ(in); ok {
			t.Errorf("NormalizeCNPJ(%q) accepted an invalid CNPJ", in)
		}
	}
	if got := FormatCNPJ("12ABC34501DE35"); got != "12.ABC.345/01DE-35" {
		t.Errorf("FormatCNPJ = %q", got)
	}
}

func FuzzNormalizeCPF(f *testing.F) {
	for _, seed := range []string{"529.982.247-25", "111.111.111-11", "52998224725", "abc"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, s string) {
		digits, ok := NormalizeCPF(s)
		if !ok {
			return
		}
		if len(digits) != 11 || !allDigits(digits) {
			t.Fatalf("NormalizeCPF(%q) = %q", s, digits)
		}
		// A normalised CPF is stable, and so is its formatted form.
		if again, ok := NormalizeCPF(FormatCPF(digits)); !ok || again != digits {
			t.Fatalf("formatted CPF %q does not normalise back to %q", FormatCPF(digits), digits)
		}
	})
}

func FuzzNormalizeCNPJ(f *testing.F) {
	for _, seed := range []string{"11.222.333/0001-81", "12.ABC.345/01DE-35", "12abc34501de35", "zz"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, s string) {
		chars, ok := NormalizeCNPJ(s)
		if !ok {
			return
		}
		if len(chars) != 14 || chars != strings.ToUpper(chars) || !allDigits(chars[12:]) {
			t.Fatalf("NormalizeCNPJ(%q) = %q", s, chars)
		}
		if again, ok := NormalizeCNPJ(FormatCNPJ(chars)); !ok || again != chars {
			t.Fatalf("formatted CNPJ %q does not normalise back to %q", FormatCNPJ(chars), chars)
		}
	})
}
