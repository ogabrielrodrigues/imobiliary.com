import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  contractFormField,
  emptyContract,
  formatDate,
  formatMoney,
  moneyForApi,
  moneyFromApi,
  NOTICES,
  parseMoney,
  parsePercent,
  partiesOf,
  stepOfField,
  termMonths,
  addMonths,
  translateContractProblem,
  validateContract,
  validateTermination,
  type ContractInput,
} from "./contract.ts";

const valid: ContractInput = {
  ...emptyContract(),
  propertyId: "p1",
  registry: "2026/001",
  advanceRent: true,
  rent: "1.500,00",
  signedOn: "2026-09-20",
  startsOn: "2026-10-01",
  expiresOn: "2029-09-30",
  landlordIds: ["owner"],
  tenantIds: ["tenant"],
};

const fields = (c: ContractInput) => validateContract(c).map((p) => p.field);

describe("money", () => {
  it("reads amounts as people type them, in centavos", () => {
    assert.equal(parseMoney("1500"), 150_000);
    assert.equal(parseMoney("1500,5"), 150_050);
    assert.equal(parseMoney("1.500,00"), 150_000);
    assert.equal(parseMoney("1.500"), 150_000);
    assert.equal(parseMoney("1500.00"), 150_000);
    assert.equal(parseMoney("R$ 12.345.678,90"), 1_234_567_890);
    for (const bad of ["", "abc", "1,500.00", "15,000", "-1", "1.50.0"]) assert.equal(parseMoney(bad), null, bad);
  });

  it("writes them for the API, a field and a reader", () => {
    assert.equal(moneyForApi(150_005), "1500.05");
    assert.equal(moneyFromApi("1500.00"), "1.500,00");
    assert.equal(formatMoney("54000.00"), "R$ 54.000,00");
  });

  it("reads percentages from 0 to 100", () => {
    assert.equal(parsePercent("10"), 100_000);
    assert.equal(parsePercent("0,5"), 5_000);
    assert.equal(parsePercent("100"), 1_000_000);
    assert.equal(parsePercent("100,01"), null);
  });

  it("shows dates the Brazilian way", () => {
    assert.equal(formatDate("2026-10-01"), "01/10/2026");
  });
});

describe("the term", () => {
  it("counts instalments as the API does", () => {
    for (const [starts, expires, want] of [
      ["2026-10-01", "2029-09-30", 36],
      ["2026-10-01", "2029-10-01", 36],
      ["2026-10-01", "2029-10-02", 37],
      ["2026-01-31", "2026-02-28", 1],
      ["2026-10-15", "2027-04-14", 6],
      ["2026-10-01", "2026-10-20", 1],
    ] as const) {
      assert.equal(termMonths(starts, expires), want, `${starts} to ${expires}`);
    }
    assert.equal(addMonths("2027-01-31", 1), "2027-02-28");
    assert.equal(addMonths("2027-11-30", 3), "2028-02-29");
  });
});

describe("validateContract", () => {
  it("accepts a complete lease", () => {
    assert.deepEqual(validateContract(valid), []);
  });

  it("asks for what is missing", () => {
    assert.deepEqual(fields(emptyContract()).sort(), [
      "advanceRent",
      "expiresOn",
      "landlordIds",
      "propertyId",
      "registry",
      "rent",
      "signedOn",
      "startsOn",
      "tenantIds",
    ]);
  });

  it("keeps the structural rules of the API", () => {
    assert.deepEqual(fields({ ...valid, guaranteeKind: "surety" }), ["guarantorIds"]);
    assert.deepEqual(fields({ ...valid, guaranteeKind: "surety", guarantorIds: ["tenant"] }), ["guarantorIds"]);
    assert.deepEqual(fields({ ...valid, tenantIds: ["owner"] }), ["tenantIds"]);
    assert.deepEqual(fields({ ...valid, guaranteeKind: "deposit" }), ["depositAmount"]);
    assert.deepEqual(fields({ ...valid, rent: "0" }), ["rent"]);
    assert.deepEqual(fields({ ...valid, dueDay: "32" }), ["dueDay"]);
    assert.deepEqual(fields({ ...valid, adminFee: "101" }), ["adminFee"]);
    assert.deepEqual(fields({ ...valid, expiresOn: "2026-10-01" }), ["expiresOn"]);
    assert.deepEqual(fields({ ...valid, expiresOn: "2080-01-01" }), ["expiresOn"]);
  });

  it("sends the parties in the API's order", () => {
    assert.deepEqual(partiesOf({ ...valid, guarantorIds: ["g"] }), [
      { personId: "owner", role: "landlord" },
      { personId: "tenant", role: "tenant" },
      { personId: "g", role: "guarantor" },
    ]);
  });
});

describe("the API's answers", () => {
  it("names each notice in Portuguese", () => {
    const problem = translateContractProblem({ field: "acknowledgments", message: "deposit_limit" });
    assert.equal(problem.message, `Confirme a ciência do aviso "${NOTICES.deposit_limit.title}".`);
    assert.equal(stepOfField(problem.field), "review");
  });

  it("puts each problem on a field of the right step", () => {
    const overlap = translateContractProblem({ field: "starts_on", message: "the property already has a contract in this period" });
    assert.deepEqual(overlap, { field: "startsOn", message: "O imóvel já tem um contrato neste período." });
    assert.equal(stepOfField(overlap.field), "terms");
    assert.equal(contractFormField("parties[2].person_id"), "parties");
    assert.equal(stepOfField("parties"), "parties");
    assert.equal(stepOfField("registry"), "property");
    assert.equal(contractFormField("advance_rent"), "advanceRent");
    assert.equal(stepOfField("advanceRent"), "parties");
    assert.equal(translateContractProblem({ field: "rent", message: "new" }).message, "Valor não aceito. Confira este campo.");
  });

  it("checks a termination date against the term", () => {
    const terms = { startsOn: "2026-10-01", expiresOn: "2027-09-30" } as Parameters<typeof validateTermination>[0];
    assert.equal(validateTermination(terms, "2027-01-31"), null);
    assert.notEqual(validateTermination(terms, "2026-09-30"), null);
    assert.notEqual(validateTermination(terms, "2027-10-01"), null);
    assert.notEqual(validateTermination(terms, ""), null);
  });
});

describe("platform copy", () => {
  it("has no em dash in the notices", () => {
    for (const notice of Object.values(NOTICES)) assert.ok(!`${notice.title}${notice.text}`.includes("—"));
  });
});
