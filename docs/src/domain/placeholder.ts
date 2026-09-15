/**
 * Placeholders — the fields a template declares.
 *
 * The API accepts flat, lowercase snake_case names only: `{{.locatario_nome}}`,
 * never `{{.locatario.nome}}`. Nested fields are rejected outright. The
 * hierarchy the design asks for is therefore produced here, by reading a shared
 * prefix as a group. That grouping is presentation and nothing else — it never
 * changes the name sent to the API.
 */

export const PLACEHOLDER_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_PLACEHOLDER_NAME_LENGTH = 64;

/** Mirrors the API's own rule, so a name can be checked before uploading. */
export function isValidPlaceholderName(name: string): boolean {
  return (
    name.length <= MAX_PLACEHOLDER_NAME_LENGTH && PLACEHOLDER_PATTERN.test(name)
  );
}

export interface PlaceholderField {
  /** The name as the template and the API know it, e.g. `locatario_nome`. */
  readonly name: string;
  /** What to show beside the input, e.g. `Nome` inside the Locatario group. */
  readonly label: string;
}

export interface PlaceholderGroup {
  /** The shared prefix, or null for fields that belong to no group. */
  readonly key: string | null;
  /** The prefix made readable, or null when there is no group. */
  readonly label: string | null;
  readonly fields: readonly PlaceholderField[];
}

/**
 * Turns a flat list of names into the grouped form the interface renders.
 *
 * A prefix becomes a group only when **two or more** names share it. Splitting
 * every name on its first underscore would shred ordinary two-word fields —
 * `valor_aluguel` alone is one field called "Valor aluguel", not a "Valor"
 * group containing "Aluguel". Requiring a second member is what tells a real
 * grouping from a coincidence.
 *
 * Groups come first, in the order their prefix first appears; ungrouped fields
 * follow in a final group whose key is null.
 */
export function groupPlaceholders(
  names: readonly string[],
): PlaceholderGroup[] {
  const byPrefix = new Map<string, string[]>();
  const order: string[] = [];

  for (const name of names) {
    const prefix = prefixOf(name);
    if (prefix === null) continue;

    const existing = byPrefix.get(prefix);
    if (existing) {
      existing.push(name);
    } else {
      byPrefix.set(prefix, [name]);
      order.push(prefix);
    }
  }

  const groups: PlaceholderGroup[] = [];
  const grouped = new Set<string>();

  for (const prefix of order) {
    const members = byPrefix.get(prefix) ?? [];
    if (members.length < 2) continue;

    for (const name of members) grouped.add(name);
    groups.push({
      key: prefix,
      label: humanize(prefix),
      fields: members.map((name) => ({
        name,
        label: humanize(name.slice(prefix.length + 1)),
      })),
    });
  }

  const loose = names.filter((name) => !grouped.has(name));
  if (loose.length > 0) {
    groups.push({
      key: null,
      label: null,
      fields: loose.map((name) => ({ name, label: humanize(name) })),
    });
  }

  return groups;
}

/** The part before the first underscore, or null when there is none. */
function prefixOf(name: string): string | null {
  const cut = name.indexOf("_");
  return cut > 0 ? name.slice(0, cut) : null;
}

/**
 * Makes a snake_case fragment readable: underscores become spaces, known words
 * get their accents back, acronyms are capitalised, and so is the first letter.
 *
 * Placeholder names are ASCII, so `locatario_nome` cannot carry the accent of
 * "locatário". The words below are the ones contracts and property records
 * use, where the ASCII spelling can only mean one accented word. A word that
 * could mean two things is left out and shown as typed: "e" may be "é",
 * "pais" may be "país", "esta" may be "está". Anything not listed stays as it
 * is, so a label is never wrong, only sometimes unaccented.
 */
export function humanize(fragment: string): string {
  const words = fragment
    .split("_")
    .filter((word) => word !== "")
    .map((word) => ACRONYMS.has(word) ? word.toUpperCase() : (ACCENTED.get(word) ?? word));
  if (words.length === 0) return fragment;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Shown in capitals: "cpf" reads as "CPF". */
const ACRONYMS: ReadonlySet<string> = new Set([
  "cpf", "cnpj", "rg", "cep", "uf", "iptu", "itbi", "cnh", "crea", "creci", "oab", "pis", "nis",
  "ctps", "ie", "im", "cnae", "pix", "ted", "doc", "fgts", "inss", "igpm", "ipca", "incc", "tr",
  "selic", "sac", "ltda", "me", "mei", "eireli", "sa", "id",
]);

/**
 * ASCII spelling to accented word, for words with a single reading. Kept to the
 * vocabulary of leases, sales, receipts and registrations.
 */
const ACCENTED: ReadonlyMap<string, string> = new Map([
  ["locatario", "locatário"], ["locataria", "locatária"], ["proprietario", "proprietário"],
  ["proprietaria", "proprietária"], ["usufrutuario", "usufrutuário"],
  ["beneficiario", "beneficiário"], ["cessionario", "cessionário"], ["promissario", "promissário"],
  ["mandatario", "mandatário"], ["responsavel", "responsável"], ["conjuge", "cônjuge"],
  ["viuvo", "viúvo"], ["viuva", "viúva"], ["uniao", "união"], ["estavel", "estável"],
  ["profissao", "profissão"], ["funcionario", "funcionário"], ["socio", "sócio"],
  ["socia", "sócia"], ["sindico", "síndico"], ["sindica", "síndica"],
  ["imobiliaria", "imobiliária"], ["cartorio", "cartório"], ["tabeliao", "tabelião"],
  ["orgao", "órgão"], ["numero", "número"], ["codigo", "código"], ["emissao", "emissão"],
  ["expedicao", "expedição"], ["matricula", "matrícula"], ["inscricao", "inscrição"],
  ["certidao", "certidão"], ["procuracao", "procuração"], ["razao", "razão"], ["titulo", "título"],
  ["credito", "crédito"], ["debito", "débito"], ["agencia", "agência"], ["imovel", "imóvel"],
  ["imoveis", "imóveis"], ["endereco", "endereço"], ["municipio", "município"],
  ["condominio", "condomínio"], ["edificio", "edifício"], ["predio", "prédio"], ["area", "área"],
  ["util", "útil"], ["terreo", "térreo"], ["mobilia", "mobília"], ["eletrica", "elétrica"],
  ["hidraulica", "hidráulica"], ["agua", "água"], ["gas", "gás"], ["preco", "preço"],
  ["calcao", "caução"], ["caucao", "caução"], ["fianca", "fiança"], ["correcao", "correção"],
  ["indice", "índice"], ["comissao", "comissão"], ["cobranca", "cobrança"],
  ["quitacao", "quitação"], ["rescisao", "rescisão"], ["renovacao", "renovação"],
  ["prorrogacao", "prorrogação"], ["locacao", "locação"], ["administracao", "administração"],
  ["intermediacao", "intermediação"], ["alienacao", "alienação"],
  ["transferencia", "transferência"], ["clausula", "cláusula"], ["obrigacao", "obrigação"],
  ["obrigacoes", "obrigações"], ["condicao", "condição"], ["condicoes", "condições"],
  ["observacao", "observação"], ["observacoes", "observações"], ["descricao", "descrição"],
  ["referencia", "referência"], ["servico", "serviço"], ["servicos", "serviços"],
  ["manutencao", "manutenção"], ["periodo", "período"], ["duracao", "duração"],
  ["vigencia", "vigência"], ["inicio", "início"], ["termino", "término"], ["mes", "mês"],
  ["ultimo", "último"], ["proximo", "próximo"], ["unico", "único"], ["minimo", "mínimo"],
  ["maximo", "máximo"], ["liquido", "líquido"], ["eletronico", "eletrônico"], ["genero", "gênero"],
  ["familia", "família"],
]);

/** How a placeholder is written inside a template. */
export function placeholderSyntax(name: string): string {
  return `{{.${name}}}`;
}

/**
 * A field name from what an author typed: "Nome do locatário" becomes
 * `nome_do_locatario`. Accents are removed (and "º" read as "o"), anything that is not a letter or a
 * digit becomes one underscore, and a leading digit gets a `campo_` prefix, so
 * the result always satisfies `isValidPlaceholderName` unless it is empty or
 * too long.
 */
export function toPlaceholderName(label: string): string {
  const name = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (name === "") return "";
  return /^[0-9]/.test(name) ? `campo_${name}` : name;
}
