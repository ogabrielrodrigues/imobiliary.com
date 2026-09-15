import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isValidPlaceholderName, toPlaceholderName } from "./placeholder.ts";

describe("a field name from typed words", () => {
  it("drops accents, case and punctuation", () => {
    assert.equal(toPlaceholderName("Nome do locatário"), "nome_do_locatario");
    assert.equal(toPlaceholderName("  CPF / CNPJ  "), "cpf_cnpj");
    assert.equal(toPlaceholderName("valor_aluguel"), "valor_aluguel");
  });

  it("never starts with a digit", () => {
    assert.equal(toPlaceholderName("1º fiador"), "campo_1o_fiador");
    assert.ok(isValidPlaceholderName(toPlaceholderName("2 testemunhas")));
  });

  it("is empty when nothing usable was typed", () => {
    assert.equal(toPlaceholderName("—!?"), "");
  });
});
