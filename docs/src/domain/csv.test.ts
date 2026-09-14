import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeSpreadsheet,
  detectSeparator,
  parseSpreadsheet,
  writeSpreadsheet,
} from "./csv.ts";

describe("decodeSpreadsheet", () => {
  it("reads UTF-8 and drops a byte order mark", () => {
    const bytes = new TextEncoder().encode("\uFEFFNome;Cidade\r\nJoão;São Paulo");
    assert.equal(decodeSpreadsheet(bytes), "Nome;Cidade\r\nJoão;São Paulo");
  });

  it("falls back to Windows-1252, the way Excel saves", () => {
    // "João" in Windows-1252: ã is the single byte 0xE3, invalid as UTF-8.
    const bytes = Uint8Array.from([0x4a, 0x6f, 0xe3, 0x6f]);
    assert.equal(decodeSpreadsheet(bytes), "João");
  });
});

describe("detectSeparator", () => {
  it("finds the separator the header line uses most", () => {
    assert.equal(detectSeparator("Nome;CPF;Cidade\nAna;1,5;X"), ";");
    assert.equal(detectSeparator("Carimbo,Nome,Cidade"), ",");
    assert.equal(detectSeparator("Nome\tCidade"), "\t");
  });

  it("ignores separators inside quotes", () => {
    assert.equal(detectSeparator('"Nome, completo";Cidade;UF'), ";");
  });
});

describe("parseSpreadsheet", () => {
  it("reads an Excel export with semicolons and CRLF", () => {
    assert.deepEqual(parseSpreadsheet("Nome;Valor\r\nAna;1.500,00\r\nBia;900,00\r\n"), {
      headers: ["Nome", "Valor"],
      rows: [
        ["Ana", "1.500,00"],
        ["Bia", "900,00"],
      ],
    });
  });

  it("reads a Google Forms export with quoted commas and line breaks", () => {
    const text =
      'Carimbo de data/hora,Nome do locatário,Endereço\n' +
      '14/09/2026 10:00:00,Ana Souza,"Rua A, 12\nApto 3"\n' +
      '14/09/2026 10:05:00,"Bia ""Bibi"" Lima",Rua B\n';
    assert.deepEqual(parseSpreadsheet(text), {
      headers: ["Carimbo de data/hora", "Nome do locatário", "Endereço"],
      rows: [
        ["14/09/2026 10:00:00", "Ana Souza", "Rua A, 12\nApto 3"],
        ["14/09/2026 10:05:00", 'Bia "Bibi" Lima', "Rua B"],
      ],
    });
  });

  it("skips blank lines, trims values and pads short rows", () => {
    assert.deepEqual(parseSpreadsheet("\n Nome ; Cidade \n\n Ana \n;;\n"), {
      headers: ["Nome", "Cidade"],
      rows: [["Ana", ""]],
    });
  });

  it("answers an empty file with no headers and no rows", () => {
    assert.deepEqual(parseSpreadsheet("\r\n  \r\n"), { headers: [], rows: [] });
  });
});

describe("writeSpreadsheet", () => {
  it("writes what Excel in Brazil opens, and reads back the same", () => {
    const sheet = { headers: ["Nome", "Endereço"], rows: [["Ana; Souza", 'Rua "A"']] };
    const text = writeSpreadsheet(sheet);
    assert.ok(text.startsWith("\uFEFF"));
    assert.ok(text.includes("\r\n"));
    assert.deepEqual(parseSpreadsheet(decodeSpreadsheet(new TextEncoder().encode(text))), sheet);
  });
});
