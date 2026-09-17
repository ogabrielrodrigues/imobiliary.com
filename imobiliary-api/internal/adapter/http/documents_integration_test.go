//go:build integration

package http_test

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
)

func TestContractDocumentFields(t *testing.T) {
	f := newLease(t)
	a := f.a
	joana := a.createPerson(f.admin, individual("Joana Lima", "gender", "female", "nationality", "brasileira",
		"marital_status", "married", "property_regime", "partial_community", "occupation", "professora"))
	body := f.contract("2026/015", "2026-10-01", "2027-09-30", "rent", "1600.00",
		"guarantee_kind", "deposit", "deposit_amount", "4800.00", "acknowledgments", []string{"advance_rent"},
		"parties", []map[string]any{
			{"person_id": f.tenant.ID, "role": "tenant"},
			{"person_id": joana.ID, "role": "tenant"},
		})
	c := f.create(body)

	var out struct {
		Fields []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"fields"`
	}
	a.expect(http.StatusOK, http.MethodGet, "/v1/contracts/"+c.ID+"/document-fields", f.admin.access, nil).decode(t, &out)
	fields := map[string]string{}
	for _, field := range out.Fields {
		fields[field.Name] = field.Value
	}
	if out.Fields[0].Name != "contrato_numero" || len(out.Fields) != len(fields) {
		t.Fatalf("fields not listed in order once each: %d", len(out.Fields))
	}

	for name, want := range map[string]string{
		"contrato_numero":         "2026/015",
		"locador_nome":            "Maria da Conceição",
		"locador_termo":           "a locadora",
		"locador_titulo":          "LOCADORA",
		"locatario_nome":          "Pedro Souza e Joana Lima",
		"locatario_termo":         "os(as) locatários(as)", // Pedro has no gender registered
		"locatario_titulo":        "LOCATÁRIOS(AS)",
		"fiador_qualificacao":     "",
		"imovel_endereco":         "Rua das Flores, 120, Centro, Bebedouro/SP, CEP 14700-000",
		"aluguel_valor":           "R$ 1.600,00",
		"aluguel_extenso":         "mil e seiscentos reais",
		"garantia_texto":          "Caução em dinheiro no valor de R$ 4.800,00 (quatro mil e oitocentos reais), correspondente a 03 (três) aluguéis.",
		"caucao_alugueis":         "03 (três)",
		"prazo_meses":             "12 (doze) meses",
		"data_inicio":             "01/10/2026",
		"data_termino":            "30/09/2027",
		"data_primeiro_reajuste":  "01/10/2027",
		"data_assinatura_extenso": "1 de outubro de 2026",
		"indice_reajuste":         "IGP-M/FGV",
		"vencimento_dia":          "10 (dez)",
		"multa_atraso":            "10% (dez por cento)",
		"juros_atraso":            "1% (um por cento) ao mês",
		"promissorias_quantidade": "12 (doze)",
		"promissorias_periodo":    "outubro/2026 a setembro/2027",
		"foro":                    "Bebedouro/SP",
	} {
		if fields[name] != want {
			t.Errorf("%s = %q, want %q", name, fields[name], want)
		}
	}
	if q := fields["locatario_qualificacao"]; !strings.Contains(q, "; e Joana Lima, brasileira, casada sob o regime da comunhão parcial de bens, professora, portadora da Carteira de Identidade Nacional (CIN) n.º ") {
		t.Errorf("tenants' qualification %q", q)
	}
	if q := fields["locador_qualificacao"]; !strings.Contains(q, "residente e domiciliada à Rua das Flores, 120, Centro, Bebedouro/SP, CEP 14700-000") {
		t.Errorf("landlord's qualification %q", q)
	}

	other := a.officeAdmin("bia@example.com", "Norte")
	a.expect(http.StatusNotFound, http.MethodGet, "/v1/contracts/"+c.ID+"/document-fields", other.access, nil)
}

func TestDocgenToken(t *testing.T) {
	a := newAPI(t)
	admin := a.officeAdmin("ana@example.com", "Central")
	var out struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
	}
	a.expect(http.StatusOK, http.MethodPost, "/v1/sessions/docgen-token", admin.access, nil).decode(t, &out)
	parts := strings.Split(out.Token, ".")
	if len(parts) != 3 || out.ExpiresAt == "" {
		t.Fatalf("token %q", out.Token)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"aud":["docgen"]`, `"email":"ana@example.com"`, `"org_name":"Central"`, `"role":"admin"`} {
		if !strings.Contains(string(payload), want) {
			t.Errorf("payload %s lacks %s", payload, want)
		}
	}
	// It opens nothing here.
	a.expect(http.StatusUnauthorized, http.MethodGet, "/v1/me", out.Token, nil)
	a.expect(http.StatusUnauthorized, http.MethodPost, "/v1/sessions/docgen-token", "", nil)
}
