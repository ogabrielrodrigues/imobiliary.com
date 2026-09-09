import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ValidationError } from "./errors.ts";
import {
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  validateLogin,
  validateRegistration,
} from "./user.ts";
import {
  groupPlaceholders,
  humanize,
  isValidPlaceholderName,
  placeholderSyntax,
} from "./placeholder.ts";
import { formatBytes } from "./template.ts";
import {
  countFilled,
  suggestFilename,
  validateDocumentData,
} from "./document.ts";

describe("email", () => {
  it("normalises the way the API does", () => {
    assert.equal(normalizeEmail("  ADA@Example.COM "), "ada@example.com");
  });
});

describe("registration", () => {
  const valid = {
    email: "ada@example.com",
    name: "Ada Lovelace",
    password: "uma-senha-bem-longa",
  };

  it("accepts valid input", () => {
    assert.equal(validateRegistration(valid), null);
  });

  it("reports every problem at once", () => {
    const invalid = validateRegistration({
      email: "",
      name: "  ",
      password: "",
    });

    assert.ok(invalid instanceof ValidationError);
    assert.equal(invalid.fields.length, 3);
  });

  // The API enforces 12; the design system's copy says 8 and is wrong. If this
  // test ever fails because the constant moved, the API moved first — or
  // someone weakened the client to make a form easier, which is the bug.
  it("requires at least as long a password as the API", () => {
    assert.equal(MIN_PASSWORD_LENGTH, 12);

    const invalid = validateRegistration({
      ...valid,
      password: "x".repeat(MIN_PASSWORD_LENGTH - 1),
    });
    assert.ok(invalid?.messageFor("password"));
  });

  it("counts password length in characters, not bytes", () => {
    // Twelve accented characters are twelve characters, even though they are
    // more than twelve bytes.
    assert.equal(validateRegistration({ ...valid, password: "ç".repeat(12) }), null);
  });

  it("rejects a malformed address", () => {
    const invalid = validateRegistration({ ...valid, email: "not-an-address" });
    assert.ok(invalid?.messageFor("email"));
  });
});

describe("login", () => {
  it("only checks for emptiness", () => {
    // A short password must still be accepted at the login screen: the account
    // may predate the rule, and complaining would describe the stored secret.
    assert.equal(
      validateLogin({ email: "ada@example.com", password: "short" }),
      null,
    );
  });

  it("catches an empty form", () => {
    const invalid = validateLogin({ email: "", password: "" });
    assert.equal(invalid?.fields.length, 2);
  });
});

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
    assert.equal(groups[0]?.label, "Locatario");
    assert.deepEqual(
      groups[0]?.fields.map((f) => f.label),
      ["Nome", "Cpf"],
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
      ["Valor aluguel", "Cpf"],
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

  it("makes a fragment readable without inventing accents", () => {
    assert.equal(humanize("nome_completo"), "Nome completo");
    // "locatario" is not turned into "locatário": the data does not say so.
    assert.equal(humanize("locatario"), "Locatario");
  });
});

describe("document data", () => {
  const schema = ["customer_name", "plan"];

  it("accepts an exact match", () => {
    assert.equal(
      validateDocumentData(schema, { customer_name: "Ada", plan: "Premium" }),
      null,
    );
  });

  it("reports a missing field", () => {
    const invalid = validateDocumentData(schema, { customer_name: "Ada" });
    assert.ok(invalid?.messageFor("data.plan"));
  });

  it("treats a blank value as missing", () => {
    const invalid = validateDocumentData(schema, {
      customer_name: "Ada",
      plan: "   ",
    });
    assert.ok(invalid?.messageFor("data.plan"));
  });

  // Dropping an unknown key silently would produce a document missing text the
  // user believed they had supplied.
  it("reports a misspelled field rather than ignoring it", () => {
    const invalid = validateDocumentData(schema, {
      customer_name: "Ada",
      plan: "Premium",
      paln: "typo",
    });
    assert.ok(invalid?.messageFor("data.paln"));
  });

  it("counts how many are filled", () => {
    assert.equal(countFilled(schema, { customer_name: "Ada", plan: "" }), 1);
    assert.equal(countFilled(schema, {}), 0);
  });
});

describe("formatting", () => {
  it("renders byte counts in Brazilian notation", () => {
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1024), "1,0 kB");
    assert.equal(formatBytes(1_258_291), "1,2 MB");
    assert.equal(formatBytes(10 * 1024 * 1024), "10 MB");
  });

  it("suggests a filename without accents or spaces", () => {
    assert.equal(
      suggestFilename("Contrato de Locação Residencial"),
      "contrato-de-locacao-residencial.docx",
    );
    assert.equal(suggestFilename("!!!"), "documento.docx");
  });
});
