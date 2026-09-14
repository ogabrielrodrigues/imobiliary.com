import {
  IconAlertCircle,
  IconCircleCheck,
  IconDownload,
  IconFileZip,
  IconHistory,
  IconPlayerStop,
  IconRefresh,
  IconStack2,
} from "@tabler/icons-react";
import { useId, useMemo, useRef, useState } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { summaryOf, type Failure } from "@/application/result";
import { Dropzone } from "@/components/dropzone";
import { FormField } from "@/components/form-field";
import { LoadFailure, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  batchCount,
  matchColumns,
  MAX_BATCH_NAME_LENGTH,
  MAX_BATCH_ROWS,
  rowData,
  type Batch,
} from "@/domain/batch";
import { decodeSpreadsheet, parseSpreadsheet, writeSpreadsheet, type Spreadsheet } from "@/domain/csv";
import { validateDocumentData } from "@/domain/document";
import {
  cleanDocumentName,
  dateForName,
  decodeNameSource,
  defaultNameSource,
  encodeNameSource,
  suggestDocumentName,
  toFilename,
  type NameSource,
} from "@/domain/document-name";
import type { FieldError } from "@/domain/errors";
import { groupPlaceholders } from "@/domain/placeholder";
import type { Template } from "@/domain/template";
import { saveFile } from "@/lib/download";
import { cn } from "@/lib/utils";
import { invalidateAfter, templateContentQuery } from "@/queries/options";
import { generateDocument } from "@/server/documents";
import { createBatch, downloadBatch } from "@/server/history";

export const Route = createFileRoute("/_app/templates/$templateId_/lote")({
  // Always the latest version: a batch records the version it was created
  // for, and every document of it is generated from that one.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(templateContentQuery(params.templateId, undefined)),
  head: () => ({ meta: [{ title: "Gerar em lote | Imobiliary Docs" }] }),
  component: BatchPage,
});

function BatchPage() {
  const { templateId } = Route.useParams();
  const { data: result } = useSuspenseQuery(templateContentQuery(templateId, undefined));

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Gerar em lote" />
        <PageBody>
          <LoadFailure failure={result.failure} />
        </PageBody>
      </>
    );
  }
  return <BatchScreen template={result.value.template} />;
}

type RowStatus =
  | { readonly state: "queued" }
  | { readonly state: "generating" }
  | { readonly state: "done" }
  | { readonly state: "failed"; readonly message: string };

interface PreparedRow {
  /** Zero-based position among the spreadsheet's rows. */
  readonly index: number;
  readonly data: Readonly<Record<string, string>>;
  readonly name: string;
  readonly problems: readonly FieldError[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Each placeholder's readable label, "Locatario › Nome", in the template's order. */
function fieldLabels(placeholders: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const group of groupPlaceholders(placeholders)) {
    for (const field of group.fields) {
      labels.set(field.name, group.label === null ? field.label : `${group.label} › ${field.label}`);
    }
  }
  return labels;
}

function BatchScreen({ template }: { readonly template: Template }) {
  const queryClient = useQueryClient();
  const placeholders = template.version?.placeholders ?? [];
  const version = template.version?.version ?? template.latestVersion;
  const labels = useMemo(() => fieldLabels(placeholders), [placeholders]);
  const [today] = useState(() => new Date());

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [sheet, setSheet] = useState<Spreadsheet | null>(null);
  const [columns, setColumns] = useState<Record<string, number | null>>({});
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(() => new Set());
  const [nameSource, setNameSource] = useState<NameSource>(() => defaultNameSource(placeholders));
  const [batchName, setBatchName] = useState(() =>
    cleanDocumentName(`${template.name} - lote de ${dateForName(today)}`).slice(0, MAX_BATCH_NAME_LENGTH),
  );
  const [nameTouched, setNameTouched] = useState(false);

  const [phase, setPhase] = useState<"setup" | "running" | "finished">("setup");
  const [batch, setBatch] = useState<Batch | null>(null);
  const [statuses, setStatuses] = useState<Readonly<Record<number, RowStatus>>>({});
  const [waiting, setWaiting] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [savingZip, setSavingZip] = useState(false);
  const stop = useRef(false);

  const rows: readonly PreparedRow[] = useMemo(() => {
    if (sheet === null) return [];
    return sheet.rows.map((row, index) => {
      const data = rowData(placeholders, columns, row);
      return {
        index,
        data,
        name: suggestDocumentName(template.name, nameSource, data, today),
        problems: validateDocumentData(placeholders, data)?.fields ?? [],
      };
    });
  }, [sheet, columns, nameSource, placeholders, template.name, today]);

  const selected = rows.filter((row) => row.problems.length === 0 && !excluded.has(row.index));
  const batchNameError =
    batchName.trim() === ""
      ? "Dê um nome ao lote."
      : [...batchName.trim()].length > MAX_BATCH_NAME_LENGTH
        ? `O nome deve ter no máximo ${MAX_BATCH_NAME_LENGTH} caracteres.`
        : undefined;

  const done = Object.values(statuses).filter((s) => s.state === "done").length;
  const failed = rows.filter((row) => statuses[row.index]?.state === "failed");
  const settled = Object.values(statuses).filter((s) => s.state === "done" || s.state === "failed").length;
  const total = Object.keys(statuses).length;
  const locked = phase !== "setup";

  function downloadModel() {
    const headers = placeholders.map((name) => labels.get(name) ?? name);
    const text = writeSpreadsheet({ headers, rows: [] });
    saveFile(
      `${cleanDocumentName(template.name) || "planilha"} - planilha.csv`,
      "text/csv;charset=utf-8",
      new TextEncoder().encode(text),
    );
  }

  async function pick(chosen: File | null) {
    setFile(chosen);
    setFileError(undefined);
    setSheet(null);
    setExcluded(new Set());
    if (chosen === null) return;

    if (!chosen.name.toLowerCase().endsWith(".csv")) {
      setFileError("Envie um arquivo .csv. No Excel: Arquivo › Salvar como › CSV.");
      return;
    }

    const parsed = parseSpreadsheet(decodeSpreadsheet(new Uint8Array(await chosen.arrayBuffer())));
    if (parsed.headers.length === 0) {
      setFileError("A planilha está vazia.");
    } else if (parsed.rows.length === 0) {
      setFileError("A planilha só tem a linha de títulos. Preencha uma linha por documento.");
    } else if (parsed.rows.length > MAX_BATCH_ROWS) {
      setFileError(
        `A planilha tem ${parsed.rows.length} linhas; o máximo por lote é ${MAX_BATCH_ROWS}. Divida em mais de uma planilha.`,
      );
    } else {
      setSheet(parsed);
      setColumns(matchColumns(placeholders, parsed.headers));
    }
  }

  /** What went wrong with one row, in words that name the field. */
  function rowMessage(problem: Failure): string {
    if (problem.kind === "validation") {
      const first = problem.fields[0];
      if (first !== undefined) {
        const name = first.field.startsWith("data.") ? first.field.slice("data.".length) : first.field;
        return `${labels.get(name) ?? name}: ${first.message}`;
      }
    }
    return summaryOf(problem) ?? "Não foi possível gerar.";
  }

  async function run(queue: readonly PreparedRow[]) {
    stop.current = false;
    setFailure(null);
    setPhase("running");

    let current = batch;
    if (current === null) {
      const created = await createBatch({ data: { templateId: template.id, version, name: batchName } });
      if (!created.ok) {
        setFailure(created.failure);
        setPhase("setup");
        return;
      }
      current = created.value;
      setBatch(current);
    }

    const batchId = current.id;
    setStatuses((previous) => ({
      ...previous,
      ...Object.fromEntries(queue.map((row) => [row.index, { state: "queued" } as RowStatus])),
    }));

    for (const row of queue) {
      if (stop.current) break;
      setStatuses((previous) => ({ ...previous, [row.index]: { state: "generating" } }));

      const attempt = () =>
        generateDocument({
          data: {
            templateId: template.id,
            filename: toFilename(row.name),
            data: row.data,
            placeholders,
            batchId,
          },
        });

      let result = await attempt();
      // The API allows twenty generations at once and two a second after
      // that. Waiting out its Retry-After is the batch keeping pace, not a
      // failure of the row.
      while (!result.ok && result.failure.kind === "rate_limit" && !stop.current) {
        const seconds = Math.max(1, result.failure.retryAfterSeconds);
        setWaiting(seconds);
        await sleep(seconds * 1000);
        setWaiting(null);
        result = await attempt();
      }

      const outcome: RowStatus = result.ok
        ? { state: "done" }
        : { state: "failed", message: rowMessage(result.failure) };
      setStatuses((previous) => ({ ...previous, [row.index]: outcome }));
    }

    // Rows never reached after a stop go back to waiting for a decision.
    if (stop.current) {
      setStatuses((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([, status]) => status.state !== "queued")),
      );
    }
    setWaiting(null);
    setPhase("finished");
    await invalidateAfter(queryClient, "batchChanged");
  }

  async function saveZip() {
    if (batch === null) return;
    setSavingZip(true);
    try {
      const archive = await downloadBatch({ data: batch.id });
      if (archive.ok) {
        saveFile(archive.value.filename, archive.value.contentType, archive.value.bytes);
      } else {
        setFailure(archive.failure);
      }
    } finally {
      setSavingZip(false);
    }
  }

  const unmatched = placeholders.filter((name) => columns[name] === null || columns[name] === undefined);
  const pending = selected.filter((row) => statuses[row.index] === undefined);

  return (
    <>
      <PageHeader
        title="Gerar em lote"
        actions={
          <Link
            to="/templates/$templateId"
            params={{ templateId: template.id }}
            className="rounded-md px-3 py-2 text-small text-muted-foreground hover:text-foreground"
          >
            Voltar ao modelo
          </Link>
        }
      />
      <PageBody>
        <p className="flex max-w-3xl items-center gap-2 text-small text-muted-foreground">
          <IconStack2 aria-hidden="true" className="size-4 shrink-0 text-docs-soft" />
          <span>
            <span className="font-medium text-foreground">{template.name}</span>, versão {version}. Um
            documento por linha da planilha.
          </span>
        </p>

        {failure !== null && (
          <p
            role="alert"
            className="flex max-w-3xl items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-small text-destructive-soft"
          >
            <IconAlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{summaryOf(failure) ?? "Não foi possível criar o lote."}</span>
          </p>
        )}

        <Step number={1} title="Planilha">
          <p className="text-small leading-relaxed text-muted-foreground">
            Uma linha por documento, uma coluna por campo. Comece pela planilha modelo, ou envie uma
            exportação do Google Forms: as colunas são ligadas aos campos pelo título.
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={downloadModel} className="self-start">
            <IconDownload data-icon="inline-start" aria-hidden="true" />
            Baixar planilha modelo
          </Button>
          {!locked && (
            <Dropzone
              file={file}
              onSelect={(chosen) => void pick(chosen)}
              error={fileError}
              accept=".csv,text/csv"
              title="Arraste a planilha .csv"
              hint={`ou clique para escolher · até ${MAX_BATCH_ROWS} linhas`}
              badge="csv"
            />
          )}
        </Step>

        {sheet !== null && (
          <Step number={2} title="Colunas">
            <p className="text-small leading-relaxed text-muted-foreground">
              {unmatched.length === 0
                ? "Todos os campos foram ligados a uma coluna. Confira antes de seguir."
                : `${unmatched.length === 1 ? "Um campo não encontrou" : `${unmatched.length} campos não encontraram`} coluna. Escolha qual coluna preenche cada um.`}
            </p>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {placeholders.map((name) => (
                <ColumnChoice
                  key={name}
                  label={labels.get(name) ?? name}
                  headers={sheet.headers}
                  value={columns[name] ?? null}
                  disabled={locked}
                  onChange={(index) => setColumns((current) => ({ ...current, [name]: index }))}
                />
              ))}
            </div>
          </Step>
        )}

        {sheet !== null && (
          <Step number={3} title="Revisar">
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
              <div className="min-w-64 flex-1">
                <FormField
                  name="batchName"
                  label="Nome do lote"
                  value={batchName}
                  disabled={locked}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setBatchName(value);
                  }}
                  onBlur={() => setNameTouched(true)}
                  error={nameTouched ? batchNameError : undefined}
                  hint="Aparece no histórico e dá nome ao ZIP."
                />
              </div>
              <NameSourceChoice
                placeholders={placeholders}
                value={nameSource}
                disabled={locked}
                onChange={(encoded) => {
                  const source = decodeNameSource(encoded, placeholders);
                  if (source !== null) setNameSource(source);
                }}
              />
            </div>

            <ReviewTable
              rows={rows}
              excluded={excluded}
              statuses={statuses}
              locked={locked}
              onToggle={(index) =>
                setExcluded((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })
              }
            />

            {phase === "setup" && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  disabled={selected.length === 0}
                  onClick={() => {
                    setNameTouched(true);
                    if (batchNameError === undefined) void run(selected);
                  }}
                >
                  <IconStack2 data-icon="inline-start" aria-hidden="true" />
                  Gerar {batchCount(selected.length)}
                </Button>
                {rows.length > selected.length && (
                  <span className="text-caption text-muted-foreground">
                    {rows.length - selected.length === 1
                      ? "1 linha fica de fora."
                      : `${rows.length - selected.length} linhas ficam de fora.`}
                  </span>
                )}
              </div>
            )}
          </Step>
        )}

        {phase !== "setup" && batch !== null && (
          <Step number={4} title="Gerar">
            <Progress value={total === 0 ? 0 : Math.round((settled / total) * 100)} aria-label="Progresso do lote" />
            <p aria-live="polite" className="text-small text-muted-foreground">
              {phase === "running"
                ? waiting !== null
                  ? `Aguardando o limite da API por ${waiting} s… ${settled} de ${total}.`
                  : `Gerando: ${settled} de ${total}.`
                : `${batchCount(done)} ${done === 1 ? "gerado" : "gerados"}${failed.length > 0 ? `, ${failed.length} com erro` : ""}.`}
            </p>

            {phase === "running" ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  stop.current = true;
                }}
                className="self-start"
              >
                <IconPlayerStop data-icon="inline-start" aria-hidden="true" />
                Parar
              </Button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={savingZip || done === 0} onClick={() => void saveZip()}>
                  <IconFileZip data-icon="inline-start" aria-hidden="true" />
                  {savingZip ? "Preparando…" : "Baixar ZIP"}
                </Button>
                <Button
                  variant="secondary"
                  nativeButton={false}
                  render={<Link to="/documentos" search={{ modelo: template.id }} />}
                >
                  <IconHistory data-icon="inline-start" aria-hidden="true" />
                  Ver no histórico
                </Button>
                {(failed.length > 0 || pending.length > 0) && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void run([...failed, ...pending])}
                  >
                    <IconRefresh data-icon="inline-start" aria-hidden="true" />
                    {failed.length > 0
                      ? `Tentar de novo ${failed.length === 1 ? "a que falhou" : `as ${failed.length} que falharam`}`
                      : `Continuar (${pending.length})`}
                  </Button>
                )}
              </div>
            )}
          </Step>
        )}
      </PageBody>
    </>
  );
}

function Step({
  number,
  title,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex max-w-5xl flex-col gap-3.5 rounded-lg border border-border bg-card px-5 py-4"
    >
      <h2 id={id} className="flex items-center gap-2.5 text-sm font-semibold">
        <span
          aria-hidden="true"
          className="flex size-6 items-center justify-center rounded-full bg-muted font-mono text-label text-muted-foreground"
        >
          {number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

const SELECT =
  "h-9.5 w-full rounded-md border border-input-border bg-input px-3 text-sm text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive/70";

function ColumnChoice({
  label,
  headers,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly headers: readonly string[];
  readonly value: number | null;
  readonly disabled: boolean;
  readonly onChange: (index: number | null) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value === null ? "" : String(value)}
        disabled={disabled}
        aria-invalid={value === null}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          onChange(raw === "" ? null : Number(raw));
        }}
        className={SELECT}
      >
        <option value="">Escolha a coluna…</option>
        {headers.map((header, index) => (
          <option key={index} value={index}>
            {header === "" ? `Coluna ${index + 1}` : header}
          </option>
        ))}
      </select>
    </div>
  );
}

function NameSourceChoice({
  placeholders,
  value,
  disabled,
  onChange,
}: {
  readonly placeholders: readonly string[];
  readonly value: NameSource;
  readonly disabled: boolean;
  readonly onChange: (encoded: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Nome de cada documento: modelo +</Label>
      <select
        id={id}
        value={encodeNameSource(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        className={cn(SELECT, "min-w-48")}
      >
        {groupPlaceholders(placeholders).map((group) =>
          group.label === null ? (
            group.fields.map((field) => (
              <option key={field.name} value={`field:${field.name}`}>
                {field.label}
              </option>
            ))
          ) : (
            <optgroup key={group.key ?? "__loose"} label={group.label}>
              {group.fields.map((field) => (
                <option key={field.name} value={`field:${field.name}`}>
                  {field.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
        <option value="date">Data de hoje</option>
        <option value="none">Nada, só o nome do modelo</option>
      </select>
    </div>
  );
}

function ReviewTable({
  rows,
  excluded,
  statuses,
  locked,
  onToggle,
}: {
  readonly rows: readonly PreparedRow[];
  readonly excluded: ReadonlySet<number>;
  readonly statuses: Readonly<Record<number, RowStatus>>;
  readonly locked: boolean;
  readonly onToggle: (index: number) => void;
}) {
  return (
    <div className="max-h-[28rem] overflow-auto rounded-lg border border-border">
      <Table className="border-collapse text-left">
        <caption className="sr-only">Linhas da planilha e o documento que cada uma gera</caption>
        <TableHeader className="sticky top-0 z-10">
          <TableRow className="border-b border-border bg-raised hover:bg-raised">
            {["Gerar", "Linha", "Nome do documento", "Situação"].map((heading) => (
              <TableHead
                key={heading}
                scope="col"
                className="h-auto px-4 py-2.5 font-mono text-label font-medium tracking-[0.08em] text-faint uppercase"
              >
                {heading}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const invalid = row.problems.length > 0;
            const status = statuses[row.index];
            // The spreadsheet's own line number: its titles are line 1.
            const line = row.index + 2;
            return (
              <TableRow key={row.index} className="border-b border-muted hover:bg-row-hover">
                <TableCell className="px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={!invalid && !excluded.has(row.index)}
                    disabled={invalid || locked}
                    onChange={() => onToggle(row.index)}
                    aria-label={`Gerar o documento da linha ${line}`}
                    className="size-4 rounded-[4px] accent-primary"
                  />
                </TableCell>
                <TableCell className="px-4 py-2.5 font-mono text-caption tabular-nums text-muted-foreground">
                  {line}
                </TableCell>
                <TableCell className="px-4 py-2.5 text-small whitespace-normal">{row.name}</TableCell>
                <TableCell className="px-4 py-2.5 text-small whitespace-normal">
                  <RowState invalid={invalid} problems={row.problems} status={status} excluded={excluded.has(row.index)} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function RowState({
  invalid,
  problems,
  status,
  excluded,
}: {
  readonly invalid: boolean;
  readonly problems: readonly FieldError[];
  readonly status: RowStatus | undefined;
  readonly excluded: boolean;
}) {
  if (status?.state === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 text-success-soft">
        <IconCircleCheck aria-hidden="true" className="size-4" />
        Gerado
      </span>
    );
  }
  if (status?.state === "failed") {
    return <span className="text-destructive-soft">{status.message}</span>;
  }
  if (status?.state === "generating") return <span className="text-muted-foreground">Gerando…</span>;
  if (status?.state === "queued") return <span className="text-faint">Na fila</span>;
  if (invalid) {
    const missing = problems.length;
    return (
      <span className="text-destructive-soft">
        {missing === 1 ? "1 campo vazio ou inválido" : `${missing} campos vazios ou inválidos`}
      </span>
    );
  }
  return <span className="text-muted-foreground">{excluded ? "Fora do lote" : "Pronta"}</span>;
}
