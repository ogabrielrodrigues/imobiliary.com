import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  cleanDocumentName,
  decodeNameSource,
  defaultNameSource,
  displayName,
  encodeNameSource,
  MAX_DOCUMENT_NAME_BYTES,
  suggestDocumentName,
  toFilename,
  validateDocumentName,
} from "./document-name.ts";

const TODAY = new Date(2026, 8, 14);

describe("defaultNameSource", () => {
  it("picks the first placeholder that holds a name", () => {
    assert.deepEqual(defaultNameSource(["data_aditamento", "locatario_nome", "locador_nome"]), {
      kind: "field",
      name: "locatario_nome",
    });
    assert.deepEqual(defaultNameSource(["nome", "cpf"]), { kind: "field", name: "nome" });
  });

  it("falls back to the date when no placeholder holds a name", () => {
    assert.deepEqual(defaultNameSource(["valor", "nomenclatura"]), { kind: "date" });
  });
});

describe("suggestDocumentName", () => {
  const field = { kind: "field", name: "locatario_nome" } as const;

  it("completes the template's name with the chosen field", () => {
    assert.equal(
      suggestDocumentName("Aditamento contratual", field, { locatario_nome: "Ana Silva" }, TODAY),
      "Aditamento contratual - Ana Silva",
    );
  });

  it("uses the date while the chosen field is empty", () => {
    assert.equal(
      suggestDocumentName("Aditamento contratual", field, { locatario_nome: "  " }, TODAY),
      "Aditamento contratual - 14-09-2026",
    );
  });

  it("can be just the template's name", () => {
    assert.equal(suggestDocumentName("Recibo", { kind: "none" }, {}, TODAY), "Recibo");
  });

  it("removes what the API would replace", () => {
    assert.equal(
      suggestDocumentName("Contrato", { kind: "field", name: "endereco" }, { endereco: "Rua A, 12/B" }, TODAY),
      "Contrato - Rua A 12 B",
    );
  });
});

describe("cleanDocumentName", () => {
  it("never exceeds the API's byte limit, and never splits a character", () => {
    const long = cleanDocumentName("ç".repeat(80));
    assert.ok(new TextEncoder().encode(long).length <= MAX_DOCUMENT_NAME_BYTES);
    assert.ok([...long].every((c) => c === "ç"));
  });
});

describe("validateDocumentName", () => {
  it("accepts accents, spaces, dots, hyphens and underscores", () => {
    assert.deepEqual(validateDocumentName("Aditamento - Ana Conceição_2.docx"), []);
  });

  it("refuses an empty name and characters the API would replace", () => {
    assert.equal(validateDocumentName(" ")[0]?.message, "Dê um nome ao documento.");
    assert.match(validateDocumentName("Contrato 12/2026")[0]?.message ?? "", /apenas letras/);
  });
});

describe("filenames", () => {
  it("adds the extension once, and hides it for reading", () => {
    assert.equal(toFilename("Recibo - Ana"), "Recibo - Ana.docx");
    assert.equal(toFilename("recibo.DOCX"), "recibo.DOCX");
    assert.equal(displayName("Recibo - Ana.docx"), "Recibo - Ana");
  });
});

describe("name source encoding", () => {
  it("round-trips, and forgets a field the version no longer has", () => {
    const source = { kind: "field", name: "locatario_nome" } as const;
    assert.deepEqual(decodeNameSource(encodeNameSource(source), ["locatario_nome"]), source);
    assert.equal(decodeNameSource("field:locatario_nome", ["cpf"]), null);
    assert.deepEqual(decodeNameSource("date", []), { kind: "date" });
    assert.equal(decodeNameSource(42, []), null);
  });
});
