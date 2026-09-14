import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { batchCount, headerWords, matchColumns, rowData } from "./batch.ts";

describe("headerWords", () => {
  it("reads a header, a label and a placeholder name the same way", () => {
    const key = headerWords("locatario_nome");
    assert.equal(headerWords("Nome do locatário"), key);
    assert.equal(headerWords("Locatario - Nome"), key);
    assert.equal(headerWords("  NOME  LOCATÁRIO "), key);
  });

  it("keeps words that tell fields apart", () => {
    assert.notEqual(headerWords("CPF do locatário"), headerWords("CPF do locador"));
  });
});

describe("matchColumns", () => {
  const placeholders = ["locatario_nome", "locatario_cpf", "valor_aluguel", "data_inicio"];

  it("matches a Google Forms export by the words of each question", () => {
    const headers = ["Carimbo de data/hora", "Nome do locatário", "CPF do locatário", "Valor do aluguel"];
    assert.deepEqual(matchColumns(placeholders, headers), {
      locatario_nome: 1,
      locatario_cpf: 2,
      valor_aluguel: 3,
      data_inicio: null,
    });
  });

  it("uses each column once", () => {
    assert.deepEqual(matchColumns(["nome", "nome_do"], ["Nome"]), { nome: 0, nome_do: null });
  });
});

describe("rowData", () => {
  it("takes each placeholder's value from its column, and leaves unmatched ones empty", () => {
    const columns = { locatario_nome: 1, data_inicio: null };
    assert.deepEqual(rowData(["locatario_nome", "data_inicio"], columns, ["x", "Ana"]), {
      locatario_nome: "Ana",
      data_inicio: "",
    });
  });
});

describe("batchCount", () => {
  it("says one document, or many", () => {
    assert.equal(batchCount(1), "1 documento");
    assert.equal(batchCount(48), "48 documentos");
  });
});
