import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { translateAdministratorProblem, validateAdministrator } from "./administrator.ts";

describe("the administrator", () => {
  it("checks the document against the kind", () => {
    const fields = (kind: "individual" | "company", document: string, creci = "") =>
      validateAdministrator({ kind, document, creci }).map((p) => p.field);
    assert.deepEqual(fields("individual", "529.982.247-25"), []);
    assert.deepEqual(fields("individual", "111.111.111-11"), ["document"]);
    assert.deepEqual(fields("company", "12.ABC.345/01DE-35"), []);
    assert.deepEqual(fields("company", "529.982.247-25"), ["document"]);
    assert.deepEqual(fields("individual", "529.982.247-25", "x".repeat(31)), ["creci"]);
  });

  it("translates the API's refusals", () => {
    assert.deepEqual(translateAdministratorProblem({ field: "document", message: "is not a valid CNPJ" }), {
      field: "document",
      message: "Informe um CNPJ válido.",
    });
  });
});
