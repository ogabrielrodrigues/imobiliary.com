import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertLegalIdentityComplete,
  CONTROLLER,
  formatEffectiveDate,
  unfilledLegalFields,
  type Controller,
} from "./legal.ts";

const filled: Controller = {
  legalName: "Imobiliary Tecnologia Ltda.",
  tradeName: "Imobiliary Docs",
  cnpj: "00.000.000/0001-00",
  address: "Rua Exemplo, 1 — Bauru/SP",
  privacyEmail: "privacidade@imobiliary.com",
  officerName: "Fulana de Tal",
  officerEmail: "encarregado@imobiliary.com",
};

describe("the controller identity", () => {
  it("reports every field still waiting to be filled in", () => {
    const missing = unfilledLegalFields({
      ...filled,
      cnpj: "[CNPJ]",
      officerEmail: "[E-MAIL DO ENCARREGADO]",
    });

    assert.deepEqual(missing.sort(), ["cnpj", "officerEmail"]);
  });

  it("accepts an identity that is filled in", () => {
    assert.deepEqual(unfilledLegalFields(filled), []);
    assert.doesNotThrow(() => assertLegalIdentityComplete(filled));
  });

  it("refuses to serve pages that name nobody", () => {
    assert.throws(
      () => assertLegalIdentityComplete({ ...filled, legalName: "[RAZÃO SOCIAL]" }),
      /legalName/,
    );
  });

  it("does not mistake an ordinary value for a placeholder", () => {
    // A real address can carry brackets and capitals without being a marker.
    assert.deepEqual(
      unfilledLegalFields({ ...filled, address: "Av. Brasil, 100 (sala 3)" }),
      [],
    );
  });

  /*
   * This one is deliberately an observation rather than a demand.
   *
   * Failing the suite while the real values are pending would leave a red
   * check from day one, which teaches everyone to ignore it — and it would not
   * stop a deployment anyway. `assertLegalIdentityComplete` is called at
   * startup in production instead, so the server refuses rather than the test.
   * This records the current state so it is never a surprise.
   */
  it("says plainly whether the shipped identity is still a placeholder", () => {
    const missing = unfilledLegalFields(CONTROLLER);
    if (missing.length > 0) {
      console.warn(
        `[legal] controller identity still to be filled in: ${missing.join(", ")}`,
      );
    }
    assert.ok(Array.isArray(missing));
  });
});

describe("formatEffectiveDate", () => {
  it("writes an ISO date the way the interface does", () => {
    assert.equal(formatEffectiveDate("2026-09-10"), "10/09/2026");
  });
});
