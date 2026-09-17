import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  groupPlaceholders,
  humanize,
  isValidPlaceholderName,
  placeholderSyntax,
} from "./placeholder.ts";

describe("placeholder names", () => {
  it("accepts what the API accepts", () => {
    for (const name of ["nome", "locatario_nome", "linha_1", "a"]) {
      assert.ok(isValidPlaceholderName(name), name);
    }
  });

  it("rejects what the API rejects", () => {
    for (const name of [
      "",
      "LocatarioNome",
      "_prefixado",
      "1inicial",
      "com-hifen",
      "com espaco",
      "locatario.nome",
      "a".repeat(65),
    ]) {
      assert.ok(!isValidPlaceholderName(name), name);
    }
  });

  it("writes the template syntax", () => {
    assert.equal(placeholderSyntax("locatario_nome"), "{{.locatario_nome}}");
  });
});

describe("grouping placeholders", () => {
  it("groups names that share a prefix", () => {
    const groups = groupPlaceholders([
      "locatario_nome",
      "locatario_cpf",
      "imovel_endereco",
      "imovel_area",
    ]);

    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.key, "locatario");
    assert.equal(groups[0]?.label, "Locatário");
    assert.deepEqual(
      groups[0]?.fields.map((f) => f.label),
      ["Nome", "CPF"],
    );
  });

  // The rule that stops ordinary two-word fields from being shredded into
  // fake hierarchies: one member is a coincidence, not a group.
  it("leaves a lone prefix ungrouped", () => {
    const groups = groupPlaceholders(["valor_aluguel", "cpf"]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.key, null);
    assert.deepEqual(
      groups[0]?.fields.map((f) => f.label),
      ["Valor aluguel", "CPF"],
    );
  });

  it("puts ungrouped fields after the groups", () => {
    const groups = groupPlaceholders([
      "locatario_nome",
      "locatario_cpf",
      "observacoes",
    ]);

    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.key, "locatario");
    assert.equal(groups[1]?.key, null);
    assert.deepEqual(
      groups[1]?.fields.map((f) => f.name),
      ["observacoes"],
    );
  });

  it("keeps every name exactly once", () => {
    const names = ["a_um", "a_dois", "b_um", "sozinho", "outro_composto"];
    const seen = groupPlaceholders(names).flatMap((g) =>
      g.fields.map((f) => f.name),
    );

    assert.deepEqual([...seen].sort(), [...names].sort());
  });

  it("handles an empty schema", () => {
    assert.deepEqual(groupPlaceholders([]), []);
  });

  it("makes a fragment readable", () => {
    assert.equal(humanize("nome_completo"), "Nome completo");
  });

  it("restores the accents of words with a single reading", () => {
    assert.equal(humanize("locatario"), "Locatário");
    assert.equal(humanize("data_mes"), "Data mês");
    assert.equal(humanize("endereco_do_imovel"), "Endereço do imóvel");
    assert.equal(humanize("valor_caucao"), "Valor caução");
  });

  it("writes acronyms in capitals", () => {
    assert.equal(humanize("cpf"), "CPF");
    assert.equal(humanize("locador_cnpj"), "Locador CNPJ");
    assert.equal(humanize("cep_imovel"), "CEP imóvel");
  });

  it("leaves words that could mean two things as they were typed", () => {
    // "e" may be "é" and "pais" may be "país": guessing would sometimes be wrong.
    assert.equal(humanize("pais_e_filhos"), "Pais e filhos");
    assert.equal(humanize("campo_desconhecido"), "Campo desconhecido");
  });
});
