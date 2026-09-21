import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  entryLabel,
  formatLongDate,
  formatSigned,
  groupByProperty,
  parseSigned,
  signedTotal,
  totalsByKind,
  translatePayoutProblem,
  validateManualEntry,
  validatePayout,
  type LedgerEntry,
} from "./payout.ts";

const address = { street: "Rua das Flores", number: "120", complement: "", district: "Centro", city: "Colina", state: "SP", zipCode: "", observation: "" };

function line(kind: LedgerEntry["kind"], signed: string, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: `${kind}-${signed}`,
    personId: "p",
    kind,
    amount: signed.replace("-", ""),
    signed,
    occurredOn: "2026-10-05",
    description: "",
    propertyId: "h1",
    address,
    contractId: "c",
    registry: "2026/001",
    rent: { sequence: 3, dueOn: "2026-10-10" },
    charge: null,
    payoutId: null,
    ...extra,
  };
}

const rentLines = [line("rent", "1120.00"), line("late_fee", "24.50"), line("admin_fee", "-120.40"), line("income_tax", "-70.00")];

describe("the ledger", () => {
  it("sums signed lines in centavos", () => {
    assert.equal(parseSigned("-38.10"), -3810);
    assert.equal(parseSigned("1038.10"), 103810);
    assert.equal(signedTotal(rentLines), 95410);
    assert.equal(formatSigned(-3810), "− R$ 38,10");
    assert.equal(formatSigned(103810), "R$ 1.038,10");
  });

  it("names each line as a statement does", () => {
    assert.equal(entryLabel(rentLines[0]!), "Aluguel, parcela 3 de 10/10/2026");
    assert.equal(entryLabel(rentLines[2]!), "Taxa de administração, parcela 3 de 10/10/2026");
    assert.equal(
      entryLabel(line("charge", "84.00", { charge: { kind: "property_tax", description: "" } })),
      "IPTU, parcela 3 de 10/10/2026",
    );
    assert.equal(entryLabel(line("debit", "-38.10", { description: "Conserto do chuveiro", rent: null })), "Conserto do chuveiro");
  });

  it("totals by kind, positive, and groups by property with typed lines last", () => {
    const totals = totalsByKind(rentLines);
    assert.equal(totals.admin_fee, 12040);
    assert.equal(totals.rent, 112000);
    const loose = line("credit", "5.00", { propertyId: null, address: null, rent: null, description: "Acerto" });
    const groups = groupByProperty([loose, ...rentLines]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]!.propertyId, "h1");
    assert.equal(groups[1]!.propertyId, null);
  });

  it("writes a receipt's date", () => {
    assert.equal(formatLongDate("2026-09-21"), "21 de setembro de 2026");
    assert.equal(formatLongDate("x"), "x");
  });
});

describe("what the office types", () => {
  const today = "2026-10-10";

  it("checks a debit or credit", () => {
    const fields = (amount: string, description: string, occurredOn = today) =>
      validateManualEntry({ kind: "debit", amount, description, occurredOn, propertyId: "" }, today).map((p) => p.field);
    assert.deepEqual(fields("250,00", "Conserto"), []);
    assert.deepEqual(fields("", ""), ["amount", "description"]);
    assert.deepEqual(fields("0", "x", "2026-10-11"), ["amount", "occurredOn"]);
  });

  it("checks a payout against the lines ticked", () => {
    const input = (paidOn: string) => ({ personId: "p", paidOn, entryIds: [], method: "" as const, note: "" });
    assert.deepEqual(validatePayout(input(today), rentLines, today), []);
    assert.deepEqual(validatePayout(input(today), [], today).map((p) => p.field), ["entryIds"]);
    assert.deepEqual(validatePayout(input(today), [line("debit", "-10.00")], today).map((p) => p.field), ["entryIds"]);
    assert.deepEqual(validatePayout(input("2026-10-04"), rentLines, today).map((p) => p.field), ["paidOn"]);
    assert.deepEqual(validatePayout(input("2026-10-11"), rentLines, today).map((p) => p.field), ["paidOn"]);
  });

  it("translates the API's refusals", () => {
    assert.deepEqual(translatePayoutProblem({ field: "entry_ids", message: "must all be pending" }), {
      field: "entryIds",
      message: "Algum lançamento já entrou em outro repasse. Recarregue a página.",
    });
  });
});
