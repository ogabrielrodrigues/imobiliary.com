import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { matchesTemplateSearch, type Template } from "./template.ts";

function template(name: string, description = ""): Template {
  const at = new Date("2026-09-11T12:00:00Z");
  return { id: "t1", name, description, latestVersion: 1, createdAt: at, updatedAt: at };
}

describe("matchesTemplateSearch", () => {
  const addendum = template("Aditamento de contrato de locação", "Reajuste anual pelo IGP-M");

  it("matches everything when the query is empty or blank", () => {
    assert.equal(matchesTemplateSearch(addendum, ""), true);
    assert.equal(matchesTemplateSearch(addendum, "   "), true);
  });

  it("ignores case and accents", () => {
    assert.equal(matchesTemplateSearch(addendum, "LOCACAO"), true);
    assert.equal(matchesTemplateSearch(template("Recibo de aluguel"), "recibo"), true);
  });

  it("needs every word, in any order", () => {
    assert.equal(matchesTemplateSearch(addendum, "locação aditamento"), true);
    assert.equal(matchesTemplateSearch(addendum, "aditamento distrato"), false);
  });

  it("searches the description too", () => {
    assert.equal(matchesTemplateSearch(addendum, "igp-m"), true);
  });
});
