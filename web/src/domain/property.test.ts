import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addressLine,
  addressPlace,
  emptyProperty,
  formatShare,
  parseShare,
  shareForApi,
  shareFromApi,
  splitEvenly,
  totalShares,
  validateProperty,
  type PropertyInput,
} from "./property.ts";

describe("shares", () => {
  it("reads a percentage with a comma or a dot, in millionths", () => {
    assert.equal(parseShare("50"), 500_000);
    assert.equal(parseShare("33,3333"), 333_333);
    assert.equal(parseShare("12.5"), 125_000);
    for (const bad of ["", "abc", "33,33333", "-5", "1000"]) assert.equal(parseShare(bad), null, bad);
  });

  it("writes them for the API and for a person", () => {
    assert.equal(shareForApi(333_334), "33.3334");
    assert.equal(shareForApi(500_000), "50");
    assert.equal(formatShare(125_000), "12,5");
    assert.equal(shareFromApi("50.00"), "50");
  });

  it("splits evenly with the remainder on the last owner", () => {
    assert.deepEqual(splitEvenly(3), ["33,3333", "33,3333", "33,3334"]);
    assert.deepEqual(splitEvenly(2), ["50", "50"]);
    assert.equal(totalShares(splitEvenly(7).map((share) => ({ personId: "x", share }))), 1_000_000);
  });
});

describe("validateProperty", () => {
  const valid: PropertyInput = {
    ...emptyProperty(),
    address: { ...emptyProperty().address, street: "Rua das Flores", city: "Bebedouro", state: "SP", zipCode: "14700-000" },
    owners: [{ personId: "a", share: "100" }],
  };

  it("accepts a property whose shares add up to 100", () => {
    assert.deepEqual(validateProperty(valid), []);
  });

  it("says what the shares add up to when they do not", () => {
    const problems = validateProperty({
      ...valid,
      owners: [
        { personId: "a", share: "33,3333" },
        { personId: "b", share: "33,3333" },
        { personId: "c", share: "33,3333" },
      ],
    });
    assert.deepEqual(problems, [{ field: "owners", message: "As partes somam 99,9999%. Precisam somar 100%." }]);
  });

  it("names the address lines and a share that is not a number", () => {
    const fields = validateProperty({
      ...emptyProperty(),
      owners: [{ personId: "a", share: "metade" }],
    }).map((p) => p.field);
    assert.deepEqual(fields, ["address.street", "address.city", "address.state", "address.zip_code", "owners[0].share"]);
    assert.deepEqual(validateProperty(emptyProperty()).at(-1), { field: "owners", message: "Informe ao menos um proprietário." });
  });
});

describe("address lines", () => {
  it("leaves out what is empty", () => {
    const a = { street: "Rua das Flores", number: "120", complement: "", district: "Centro", city: "Bebedouro", state: "SP", zipCode: "14700000", observation: "" };
    assert.equal(addressLine(a), "Rua das Flores, 120");
    assert.equal(addressPlace(a), "Centro, Bebedouro/SP");
  });
});
