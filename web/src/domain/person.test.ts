import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  emptyAddress,
  emptyPerson,
  isValidCNPJ,
  isValidCPF,
  maskCNPJ,
  maskCPF,
  maskPhone,
  maskZipCode,
  translatePersonProblem,
  validatePerson,
  type PersonInput,
} from "./person.ts";

const fields = (p: PersonInput) => validatePerson(p).map((problem) => problem.field);

describe("documents", () => {
  it("accepts the CPF and CNPJ the API accepts", () => {
    assert.equal(isValidCPF("529.982.247-25"), true);
    assert.equal(isValidCPF("52998224725"), true);
    assert.equal(isValidCNPJ("12.ABC.345/01DE-35"), true);
    assert.equal(isValidCNPJ("12abc34501de35"), true);
  });

  it("refuses wrong check digits, repeated digits and stray characters", () => {
    for (const cpf of ["529.982.247-24", "111.111.111-11", "5299822472x", "123"]) {
      assert.equal(isValidCPF(cpf), false, cpf);
    }
    for (const cnpj of ["12.ABC.345/01DE-36", "00.000.000/0000-00", "12.ABC.345/01DE-3A"]) {
      assert.equal(isValidCNPJ(cnpj), false, cnpj);
    }
  });

  it("masks as the characters arrive", () => {
    assert.equal(maskCPF("5299822"), "529.982.2");
    assert.equal(maskCPF("52998224725999"), "529.982.247-25");
    assert.equal(maskCNPJ("12abc34501de35"), "12.ABC.345/01DE-35");
    assert.equal(maskZipCode("14700000"), "14700-000");
    assert.equal(maskPhone("16991234567"), "(16) 99123-4567");
    assert.equal(maskPhone("1633421000"), "(16) 3342-1000");
    assert.equal(maskPhone("+55 16 99123-4567"), "+55 16 99123-4567");
  });
});

describe("validatePerson", () => {
  it("asks for the name and the CPF of an empty individual", () => {
    assert.deepEqual(fields(emptyPerson()), ["name", "cpf"]);
    assert.equal(validatePerson(emptyPerson()).at(-1)?.message, "Informe o CPF.");
    assert.equal(validatePerson({ ...emptyPerson("company") })[0]?.message, "Informe a razão social.");
  });

  it("names every field the API would refuse", () => {
    const person: PersonInput = {
      ...emptyPerson(),
      name: "Maria",
      email: "maria",
      phone: "9912-3456",
      cpf: "111.111.111-11",
      maritalStatus: "single",
      propertyRegime: "partial_community",
      spouseId: "0193",
      addresses: [
        { ...emptyAddress(true), street: "Rua A", city: "Bebedouro", state: "sp", zipCode: "14700-000" },
        { ...emptyAddress(true), state: "XX", zipCode: "1470" },
      ],
    };
    assert.deepEqual(fields(person), [
      "email",
      "phone",
      "cpf",
      "property_regime",
      "spouse_id",
      "addresses",
      "addresses[1].street",
      "addresses[1].city",
      "addresses[1].state",
      "addresses[1].zip_code",
    ]);
  });

  it("does not judge an individual's fields on a company", () => {
    const company: PersonInput = { ...emptyPerson("company"), name: "Prado Ltda", cpf: "nonsense", cnpj: "12.ABC.345/01DE-35" };
    assert.deepEqual(fields(company), []);
  });
});

describe("translatePersonProblem", () => {
  it("says the API's rules in Portuguese and never passes English through", () => {
    assert.equal(
      translatePersonProblem({ field: "cnpj", message: "is already registered in this office" }).message,
      "Este CNPJ já está cadastrado no escritório.",
    );
    assert.equal(
      translatePersonProblem({ field: "name", message: "some new rule" }).message,
      "Valor não aceito. Confira este campo.",
    );
  });
});
