import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  chargeLabel,
  daysBetween,
  monthLabel,
  monthRange,
  todayInSaoPaulo,
  translateRentProblem,
  validateCharge,
  validatePayment,
  amountReceived,
  suggestedDestination,
  destinationLabel,
} from "./rent.ts";

describe("dates", () => {
  it("reads today on the office's calendar", () => {
    // 02:00 UTC is still the previous day in São Paulo.
    assert.equal(todayInSaoPaulo(new Date("2026-10-01T02:00:00Z")), "2026-09-30");
    assert.equal(todayInSaoPaulo(new Date("2026-10-01T15:00:00Z")), "2026-10-01");
  });

  it("turns a month into its days and its name", () => {
    assert.deepEqual(monthRange("2028-02"), { from: "2028-02-01", to: "2028-02-29" });
    assert.equal(monthRange("2026-13"), null);
    assert.equal(monthLabel("2026-10"), "outubro de 2026");
    assert.equal(daysBetween("2026-11-10", "2026-11-15"), 5);
  });
});

describe("payments and charges", () => {
  const today = "2026-11-20";

  it("checks the day and typed amounts", () => {
    const fields = (paidOn: string, lateFee = "", incomeTax = "") =>
      validatePayment({ paidOn, lateFee, incomeTax }, today, "1600.00").map((p) => p.field);
    assert.deepEqual(fields("2026-11-20"), []);
    assert.deepEqual(fields(""), ["paidOn"]);
    assert.deepEqual(fields("2026-11-21"), ["paidOn"]);
    assert.deepEqual(fields("2026-11-15", "abc", "x"), ["lateFee", "incomeTax"]);
    assert.deepEqual(fields("2026-11-15", "0", "1.600,01"), ["incomeTax"]);
    assert.deepEqual(fields("2026-11-15", "0", "112,50"), []);
  });

  it("computes what a payment brings in, as the API does", () => {
    assert.equal(amountReceived("2120.00", "35,00", "100,00"), 205500);
    assert.equal(amountReceived("1600.00", "", ""), 160000);
    assert.equal(amountReceived("1600.00", "abc", ""), null);
  });

  it("suggests where a charge goes", () => {
    assert.equal(suggestedDestination("property_tax"), "owner");
    assert.equal(suggestedDestination("condominium"), "third_party");
    assert.equal(destinationLabel("owner"), "Proprietário");
  });

  it("asks what another charge is", () => {
    assert.deepEqual(validateCharge({ kind: "other", description: "", amount: "10", destination: "owner" }).map((p) => p.field), ["description"]);
    assert.deepEqual(validateCharge({ kind: "condominium", description: "", amount: "", destination: "third_party" }).map((p) => p.field), ["amount"]);
    assert.equal(chargeLabel("property_tax"), "IPTU");
  });

  it("translates the API's refusals", () => {
    assert.deepEqual(translateRentProblem({ field: "paid_on", message: "must not be in the future" }), {
      field: "paidOn",
      message: "O pagamento não pode ter data futura.",
    });
    assert.deepEqual(
      translateRentProblem({ field: "payment", message: "the rent is in payout 2026/0003; undo the payout first" }),
      { field: "form", message: "Este aluguel já entrou no repasse 2026/0003. Desfaça o repasse antes." },
    );
  });
});
