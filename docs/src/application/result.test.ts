import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summaryOf } from "./result.ts";

describe("summaryOf", () => {
  it("treats a 401 past sign-in as an expired session", () => {
    assert.equal(
      summaryOf({ kind: "authentication" }),
      "Sua sessão expirou. Entre novamente para continuar.",
    );
  });

  it("lets a credential screen say what a 401 means there", () => {
    assert.equal(
      summaryOf({ kind: "authentication" }, { authentication: "E-mail ou senha incorretos." }),
      "E-mail ou senha incorretos.",
    );
  });

  it("keeps the default for kinds a screen did not override", () => {
    assert.match(
      summaryOf({ kind: "unexpected" }, { authentication: "x" }) ?? "",
      /Algo deu errado/,
    );
  });

  it("stays silent when every problem is on a field", () => {
    assert.equal(
      summaryOf({ kind: "validation", fields: [{ field: "email", message: "x" }] }),
      null,
    );
  });
});
