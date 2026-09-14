/**
 * Reading and writing the spreadsheets a batch is generated from.
 *
 * No library: the format is small, and the two sources that matter each have a
 * quirk worth handling on purpose.
 *
 * - **Excel in Brazil** saves "CSV" with `;` between fields (the comma is the
 *   decimal separator) and, unless told otherwise, in Windows-1252 rather than
 *   UTF-8, so "João" arrives as bytes UTF-8 cannot decode.
 * - **Google Forms** exports UTF-8 with `,`, quotes around any answer holding a
 *   comma or a line break, and the question's text as each column's header.
 *
 * Quoting follows RFC 4180: a field in double quotes may hold separators and
 * line breaks, and `""` inside it is one quote.
 */

export interface Spreadsheet {
  readonly headers: readonly string[];
  /** Each row padded or cut to the header's length. */
  readonly rows: readonly (readonly string[])[];
}

const SEPARATORS = [";", ",", "\t"] as const;

/**
 * Text from the file's bytes. UTF-8 is tried strictly first; a file it cannot
 * decode is taken as Windows-1252, which is what Excel writes by default.
 */
export function decodeSpreadsheet(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  // A byte order mark is not part of the first header.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The separator of the first line: whichever of `;`, `,` and tab appears most
 * often outside quotes. A header line with none of them is a single column.
 */
export function detectSeparator(text: string): string {
  const counts = new Map<string, number>(SEPARATORS.map((s) => [s, 0]));
  let quoted = false;

  // The first line with content: an export can start with blank lines, and
  // counting on an empty one finds no separator at all.
  const start = text.search(/[^\s]/);
  const firstLine = start === -1 ? "" : text.slice(text.lastIndexOf("\n", start) + 1);

  for (const char of firstLine) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      break;
    } else if (!quoted && counts.has(char)) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }

  let best: string = ",";
  let most = 0;
  for (const [separator, count] of counts) {
    if (count > most) {
      best = separator;
      most = count;
    }
  }
  return best;
}

/** Splits text into records of fields, honouring quotes. */
function records(text: string, separator: string): string[][] {
  const out: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === separator) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      out.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || record.length > 0) {
    record.push(field);
    out.push(record);
  }
  return out;
}

/**
 * Reads a spreadsheet: the first non-empty record is the header, and every
 * following record that is not entirely blank is a row. Spaces around headers
 * and values are trimmed, which is what a person means by them.
 */
export function parseSpreadsheet(text: string): Spreadsheet {
  const all = records(text, detectSeparator(text)).filter((record) =>
    record.some((value) => value.trim() !== ""),
  );

  const [header, ...body] = all;
  if (header === undefined) return { headers: [], rows: [] };

  const headers = header.map((value) => value.trim());
  const rows = body.map((record) =>
    headers.map((_, index) => (record[index] ?? "").trim()),
  );
  return { headers, rows };
}

/**
 * A spreadsheet as a CSV Excel opens correctly in Brazil: `;` separators, CRLF
 * line endings, a byte order mark so it is read as UTF-8, and quotes around any
 * value holding a separator, a quote or a line break.
 */
export function writeSpreadsheet(sheet: Spreadsheet): string {
  const cell = (value: string) =>
    /[;"\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const line = (values: readonly string[]) => values.map(cell).join(";");

  return "\uFEFF" + [line(sheet.headers), ...sheet.rows.map(line)].join("\r\n") + "\r\n";
}
