import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { incomeReportCsv, isEmptyMonth, reportYear, type IncomeFigures, type IncomeMonth } from "./income-report.ts";

const zero: IncomeFigures = { rent: "0.00", lateFee: "0.00", charges: "0.00", adminFee: "0.00", incomeTax: "0.00" };
const empty = (month: number): IncomeMonth => ({ month, individual: zero, company: zero, debits: "0.00", credits: "0.00" });

describe("carnê-leão report", () => {
  it("reads a year from the address", () => {
    assert.equal(reportYear("2026"), 2026);
    assert.equal(reportYear(2026), 2026);
    assert.equal(reportYear("26"), undefined);
    assert.equal(reportYear("1999"), undefined);
    assert.equal(reportYear(undefined), undefined);
  });

  it("writes a spreadsheet Excel in Brazil opens", () => {
    const june: IncomeMonth = {
      ...empty(6),
      individual: { ...zero, rent: "1500.00", adminFee: "150.00" },
      company: { ...zero, rent: "12000.00", incomeTax: "22.50" },
      debits: "10.05",
    };
    const months = Array.from({ length: 12 }, (_, i) => (i === 5 ? june : empty(i + 1)));
    const csv = incomeReportCsv({
      person: { id: "p", name: "Maria", kind: "individual" },
      year: 2026,
      months,
      total: { ...june, month: 0 },
    });
    assert.ok(csv.startsWith("﻿Mês;Aluguel (locatário pessoa física);"));
    const lines = csv.split("\r\n");
    assert.equal(lines.length, 15); // header, twelve months, total, and the final line break
    assert.equal(lines[6], "Junho;1500,00;0,00;0,00;150,00;12000,00;0,00;0,00;0,00;22,50;10,05;0,00");
    assert.equal(lines[13]?.split(";")[0], "Total 2026");
    assert.ok(isEmptyMonth(empty(1)));
    assert.ok(!isEmptyMonth(june));
  });
});
