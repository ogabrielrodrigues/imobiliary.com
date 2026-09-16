/**
 * The office's people, as this platform shows and edits them.
 *
 * The rules repeated here are the API's (`internal/domain/person.go`). The API
 * checks everything again and wins any disagreement; these exist so a form can
 * say what is wrong before a round trip, in Portuguese.
 */

import type { FieldError } from "./errors.ts";

export type PersonKind = "individual" | "company";

export const MARITAL_STATUSES = [
  "single",
  "married",
  "stable_union",
  "divorced",
  "separated",
  "widowed",
] as const;
export type MaritalStatus = (typeof MARITAL_STATUSES)[number];

export const PROPERTY_REGIMES = [
  "partial_community",
  "universal_community",
  "total_separation",
  "mandatory_separation",
  "final_participation",
] as const;
export type PropertyRegime = (typeof PROPERTY_REGIMES)[number];

export type Gender = "female" | "male";

export const ADDRESS_KINDS = ["residential", "correspondence", "commercial"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

/** The 26 states and the Federal District. */
export const STATES = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
  "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
] as const;

export const MAX_PERSON_NAME_LENGTH = 200;
export const MAX_ADDRESSES = 10;
export const MAX_REPRESENTATIVES = 10;

export const KIND_LABELS: Record<PersonKind, string> = {
  individual: "Pessoa física",
  company: "Pessoa jurídica",
};

export const MARITAL_STATUS_LABELS: Record<MaritalStatus, string> = {
  single: "Solteiro(a)",
  married: "Casado(a)",
  stable_union: "União estável",
  divorced: "Divorciado(a)",
  separated: "Separado(a)",
  widowed: "Viúvo(a)",
};

export const PROPERTY_REGIME_LABELS: Record<PropertyRegime, string> = {
  partial_community: "Comunhão parcial de bens",
  universal_community: "Comunhão universal de bens",
  total_separation: "Separação total de bens",
  mandatory_separation: "Separação obrigatória de bens",
  final_participation: "Participação final nos aquestos",
};

export const GENDER_LABELS: Record<Gender, string> = {
  female: "Feminino",
  male: "Masculino",
};

export const ADDRESS_KIND_LABELS: Record<AddressKind, string> = {
  residential: "Residencial",
  correspondence: "Correspondência",
  commercial: "Comercial",
};

export interface Address {
  readonly kind: AddressKind;
  readonly isPrimary: boolean;
  readonly street: string;
  readonly number: string;
  readonly complement: string;
  readonly district: string;
  readonly city: string;
  readonly state: string;
  readonly zipCode: string;
  readonly observation: string;
}

/** What a form edits and the API receives. Empty strings mean "not given". */
export interface PersonInput {
  readonly kind: PersonKind;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly cpf: string;
  readonly nationality: string;
  readonly maritalStatus: MaritalStatus | "";
  readonly propertyRegime: PropertyRegime | "";
  readonly spouseId: string;
  readonly occupation: string;
  /** YYYY-MM-DD, or empty. */
  readonly birthDate: string;
  readonly gender: Gender | "";
  readonly cnpj: string;
  readonly tradeName: string;
  readonly representativeIds: readonly string[];
  readonly addresses: readonly Address[];
}

export interface Person extends PersonInput {
  readonly id: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PersonSummary {
  readonly id: string;
  readonly kind: PersonKind;
  readonly name: string;
  readonly tradeName: string;
}

export interface PeoplePage {
  readonly people: readonly PersonSummary[];
  readonly nextCursor: string | null;
}

export function emptyAddress(isPrimary = false): Address {
  return {
    kind: "residential",
    isPrimary,
    street: "",
    number: "",
    complement: "",
    district: "",
    city: "",
    state: "",
    zipCode: "",
    observation: "",
  };
}

export function emptyPerson(kind: PersonKind = "individual"): PersonInput {
  return {
    kind,
    name: "",
    email: "",
    phone: "",
    cpf: "",
    nationality: "",
    maritalStatus: "",
    propertyRegime: "",
    spouseId: "",
    occupation: "",
    birthDate: "",
    gender: "",
    cnpj: "",
    tradeName: "",
    representativeIds: [],
    addresses: [],
  };
}

export function hasPartner(status: MaritalStatus | ""): boolean {
  return status === "married" || status === "stable_union";
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** A CPF with valid check digits, formatted or not. */
export function isValidCPF(value: string): boolean {
  if (!/^[\d.\-\s]+$/.test(value)) return false;
  const d = digitsOf(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(d[i]) * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]);
}

/**
 * A CNPJ with valid check digits, numeric or alphanumeric (IN RFB 2.229/2024):
 * each character counts as its code minus 48.
 */
export function isValidCNPJ(value: string): boolean {
  if (!/^[\dA-Za-z./\-\s]+$/.test(value)) return false;
  const c = value.replace(/[./\-\s]/g, "").toUpperCase();
  if (!/^[\dA-Z]{12}\d{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const check = (length: number) => {
    let sum = 0;
    let weight = length - 7;
    for (let i = 0; i < length; i++) {
      sum += (c.charCodeAt(i) - 48) * weight;
      weight = weight === 2 ? 9 : weight - 1;
    }
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(c[12]) && check(13) === Number(c[13]);
}

/** Formats as the digits arrive: 000.000.000-00. */
export function maskCPF(value: string): string {
  const d = digitsOf(value).slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}

/** Formats as the characters arrive: 00.000.000/0000-00, letters allowed. */
export function maskCNPJ(value: string): string {
  const c = value.replace(/[^\dA-Za-z]/g, "").toUpperCase().slice(0, 14);
  let out = "";
  for (let i = 0; i < c.length; i++) {
    if (i === 2 || i === 5) out += ".";
    if (i === 8) out += "/";
    if (i === 12) out += "-";
    out += c[i];
  }
  return out;
}

/** Formats a CEP as 00000-000. */
export function maskZipCode(value: string): string {
  const d = digitsOf(value).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

/** Formats a Brazilian phone as (00) 00000-0000 while it has at most 11 digits. */
export function maskPhone(value: string): string {
  const raw = value.trim();
  const d = digitsOf(raw);
  if (raw.startsWith("+") || d.length > 11) return raw;
  if (d.length <= 2) return d.length === 0 ? "" : `(${d}`;
  const area = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length <= 4) return `(${area}) ${rest}`;
  const split = rest.length === 9 ? 5 : 4;
  return `(${area}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}

/** The lines every address needs, a person's or a property's. */
export interface AddressLines {
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly zipCode: string;
}

/** Problems with an address's lines, each field named after `prefix`. */
export function addressLineProblems(a: AddressLines, prefix: string): FieldError[] {
  const problems: FieldError[] = [];
  if (a.street.trim() === "") problems.push({ field: `${prefix}street`, message: "Informe o logradouro." });
  if (a.city.trim() === "") problems.push({ field: `${prefix}city`, message: "Informe a cidade." });
  if (!(STATES as readonly string[]).includes(a.state.toUpperCase())) {
    problems.push({ field: `${prefix}state`, message: "Escolha a UF." });
  }
  if (digitsOf(a.zipCode).length !== 8) problems.push({ field: `${prefix}zip_code`, message: "O CEP tem 8 dígitos." });
  return problems;
}

/**
 * Every problem the form can find on its own, named as the API names fields
 * so a server answer and a local one land on the same input.
 */
export function validatePerson(p: PersonInput): FieldError[] {
  const problems: FieldError[] = [];
  const add = (field: string, message: string) => problems.push({ field, message });

  const name = p.name.trim();
  if (name === "") {
    add("name", p.kind === "company" ? "Informe a razão social." : "Informe o nome completo.");
  } else if ([...name].length > MAX_PERSON_NAME_LENGTH) {
    add("name", `Use no máximo ${MAX_PERSON_NAME_LENGTH} caracteres.`);
  }
  if (p.email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim())) {
    add("email", "Informe um e-mail válido.");
  }
  if (p.phone.trim() !== "") {
    const digits = digitsOf(p.phone);
    if (!/^[\d\s()+.\-]+$/.test(p.phone) || digits.length < 10 || digits.length > 13) {
      add("phone", "Informe o telefone com DDD.");
    }
  }

  if (p.kind === "individual") {
    if (p.cpf.trim() === "") add("cpf", "Informe o CPF.");
    else if (!isValidCPF(p.cpf)) add("cpf", "CPF inválido. Confira os números.");
    if (p.propertyRegime !== "" && !hasPartner(p.maritalStatus)) {
      add("property_regime", "O regime de bens vale só para casamento ou união estável.");
    }
    if (p.spouseId !== "" && !hasPartner(p.maritalStatus)) {
      add("spouse_id", "O cônjuge vale só para casamento ou união estável.");
    }
    if (p.birthDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(p.birthDate)) {
      add("birth_date", "Informe uma data válida.");
    }
  } else {
    if (p.cnpj.trim() !== "" && !isValidCNPJ(p.cnpj)) add("cnpj", "CNPJ inválido. Confira os caracteres.");
    if (p.representativeIds.length > MAX_REPRESENTATIVES) {
      add("representative_ids", `Escolha no máximo ${MAX_REPRESENTATIVES} representantes.`);
    }
  }

  if (p.addresses.length > MAX_ADDRESSES) {
    add("addresses", `Cadastre no máximo ${MAX_ADDRESSES} endereços.`);
  }
  if (p.addresses.filter((a) => a.isPrimary).length > 1) {
    add("addresses", "Marque só um endereço como principal.");
  }
  p.addresses.forEach((a, i) => {
    problems.push(...addressLineProblems(a, `addresses[${i}].`));
  });

  return problems;
}

/**
 * The API's messages for the rules only it can check, in Portuguese. Anything
 * not listed keeps a generic sentence rather than showing English.
 */
export function translatePersonProblem(problem: FieldError): FieldError {
  const { field, message } = problem;
  const known: Record<string, string> = {
    "is already registered in this office":
      field === "cnpj" ? "Este CNPJ já está cadastrado no escritório." : "Este CPF já está cadastrado no escritório.",
    "names a person that does not exist": "A pessoa escolhida não existe mais.",
    "must be an individual": "O cônjuge precisa ser pessoa física.",
    "must be individuals": "Representantes precisam ser pessoas físicas.",
    "must be registered as married or in a stable union":
      "Essa pessoa não está cadastrada como casada ou em união estável.",
    "is already linked to another person": "Essa pessoa já está ligada a outro cônjuge.",
    "cannot change": "O tipo de cadastro não pode mudar.",
    "is required": field === "cpf" ? "Informe o CPF." : "Preencha este campo.",
  };
  return { field, message: known[message] ?? "Valor não aceito. Confira este campo." };
}
