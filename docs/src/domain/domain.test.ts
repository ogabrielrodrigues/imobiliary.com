import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeEmail, validateLogin, validateSecondFactorCode } from "./user.ts";
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

describe("the second factor", () => {
  it("asks for a code and nothing more", () => {
    assert.equal(validateSecondFactorCode("123456"), null);
    // A recovery code is not six digits, and only the platform knows which
    // kind was given, so length is deliberately not checked.
    assert.equal(validateSecondFactorCode("abcd-efgh"), null);
    assert.ok(validateSecondFactorCode("   ")?.messageFor("code"));
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
