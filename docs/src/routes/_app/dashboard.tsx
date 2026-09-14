import {
  IconAlertCircle,
  IconCircleCheck,
  IconDownload,
  IconFilePlus,
  IconTrendingDown,
  IconTrendingUp,
  IconUpload,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { summaryOf, type Failure } from "@/application/result";
import type { DashboardView, DocumentListItem } from "@/application/views";
import { DocumentsChart } from "@/components/dashboard/documents-chart";
import { LoadFailure, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  busiestDay,
  DEFAULT_STATS_PERIOD,
  DEFAULT_TIME_ZONE,
  isStatsPeriod,
  periodChange,
  STATS_PERIODS,
  type DashboardStats,
  type StatsPeriod,
} from "@/domain/stats";
import { displayName } from "@/domain/document-name";
import { saveFile } from "@/lib/download";
import { relativeDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { dashboardQuery } from "@/queries/options";
import { downloadDocument } from "@/server/documents";

interface DashboardSearch {
  readonly periodo?: StatsPeriod;
}

/**
 * The viewer's time zone. A server render has no browser to ask and uses the
 * product's default; every client-side navigation after it uses the real one.
 */
function viewerTimeZone(): string {
  if (typeof window === "undefined") return DEFAULT_TIME_ZONE;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
}

export const Route = createFileRoute("/_app/dashboard")({
  /** The window lives in the address, like the tab in Ajustes. */
  validateSearch: (search: Record<string, unknown>): DashboardSearch => {
    const days = Number(search["periodo"]);
    return isStatsPeriod(days) && days !== DEFAULT_STATS_PERIOD ? { periodo: days } : {};
  },
  // Without this the router treats a new window as the same match and serves
  // the cached figures.
  loaderDeps: ({ search }) => ({ periodo: search.periodo ?? DEFAULT_STATS_PERIOD }),
  /**
   * The zone is chosen here and handed to the component, never recomputed
   * there. A server render uses the default and the browser would pick its
   * own: two different keys, and hydration would fetch everything again.
   */
  loader: async ({ context, deps }) => {
    const timeZone = viewerTimeZone();
    await context.queryClient.ensureQueryData(dashboardQuery(deps.periodo, timeZone));
    return { days: deps.periodo, timeZone };
  },
  head: () => ({ meta: [{ title: "Dashboard | Imobiliary Docs" }] }),
  component: DashboardPage,
});

function DashboardPage() {
  const { days, timeZone } = Route.useLoaderData();
  const { data: result } = useSuspenseQuery(dashboardQuery(days, timeZone));

  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          <>
            <Button variant="secondary" nativeButton={false} render={<Link to="/templates" />}>
              <IconFilePlus data-icon="inline-start" aria-hidden="true" />
              Gerar documento
            </Button>
            <Button nativeButton={false} render={<Link to="/templates/novo" />}>
              <IconUpload data-icon="inline-start" aria-hidden="true" />
              Enviar modelo
            </Button>
          </>
        }
      />
      <PageBody>
        {result.ok ? (
          <DashboardContent view={result.value} />
        ) : (
          <LoadFailure failure={result.failure} />
        )}
      </PageBody>
    </>
  );
}

function DashboardContent({ view }: { readonly view: DashboardView }) {
  const { stats, recent } = view;
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <div className="flex max-w-6xl flex-col gap-5">
      <Tabs
        value={String(stats.days)}
        onValueChange={(value) => {
          const days = Number(value);
          if (!isStatsPeriod(days)) return;
          void navigate({
            search: days === DEFAULT_STATS_PERIOD ? {} : { periodo: days },
            replace: true,
          });
        }}
      >
        <TabsList aria-label="Período" className="self-start">
          {STATS_PERIODS.map((days) => (
            <TabsTrigger key={days} value={String(days)} className="px-3">
              {days} dias
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Indicators stats={stats} />

      {stats.documents === 0 ? (
        <GettingStarted hasTemplates={stats.templates > 0} />
      ) : (
        <>
          <section
            aria-labelledby="per-day-title"
            className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4 md:px-5"
          >
            <div className="flex flex-col gap-1">
              <h2 id="per-day-title" className="text-sm font-semibold">
                Documentos por dia
              </h2>
              <p className="text-caption text-muted-foreground">{perDaySummary(stats)}</p>
            </div>
            <DocumentsChart perDay={stats.perDay} />
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <TopTemplates stats={stats} />
            <RecentDocuments recent={recent} />
          </div>
        </>
      )}
    </div>
  );
}

// ----- indicators ------------------------------------------------------------

function Indicators({ stats }: { readonly stats: DashboardStats }) {
  const change = periodChange(stats.documentsInPeriod, stats.documentsPreviousPeriod);
  const top = stats.topTemplates[0];

  return (
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Indicator
        label={`Documentos em ${stats.days} dias`}
        value={stats.documentsInPeriod}
        detail={
          change === null ? (
            `Nenhum nos ${stats.days} dias anteriores`
          ) : (
            <span className="inline-flex items-center gap-1">
              {change >= 0 ? (
                <IconTrendingUp aria-hidden="true" className="size-3.5" />
              ) : (
                <IconTrendingDown aria-hidden="true" className="size-3.5" />
              )}
              {change > 0 ? "+" : ""}
              {change}% em relação aos {stats.days} dias anteriores
            </span>
          )
        }
      />
      <Indicator label="Total de documentos" value={stats.documents} detail="Desde a criação da conta" />
      <Indicator
        label="Modelos ativos"
        value={stats.templates}
        detail={
          <Link to="/templates" className="text-primary-text hover:underline">
            Ver modelos
          </Link>
        }
      />
      <Indicator
        label="Modelo mais usado"
        value={top ? top.name : "Nenhum"}
        wide
        detail={
          top
            ? `${plural(top.documents, "documento", "documentos")} em ${stats.days} dias`
            : `Nenhum documento em ${stats.days} dias`
        }
        href={top && !top.deleted ? top.templateId : undefined}
      />
    </dl>
  );
}

function Indicator({
  label,
  value,
  detail,
  wide = false,
  href,
}: {
  readonly label: string;
  readonly value: number | string;
  readonly detail: ReactNode;
  /** A name rather than a number: smaller type, and it may wrap. */
  readonly wide?: boolean;
  /** The template to link the value to. */
  readonly href?: string | undefined;
}) {
  const shown =
    typeof value === "number" ? value.toLocaleString("pt-BR") : value;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3.5">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "font-semibold tabular-nums",
          wide ? "text-title-sm leading-snug break-words" : "text-headline leading-tight",
        )}
      >
        {href ? (
          <Link
            to="/templates/$templateId"
            params={{ templateId: href }}
            className="hover:underline"
          >
            {shown}
          </Link>
        ) : (
          shown
        )}
      </dd>
      <dd className="text-caption text-muted-foreground">{detail}</dd>
    </div>
  );
}

// ----- the day chart's summary ---------------------------------------------

const LONG_DAY = new Intl.DateTimeFormat("pt-BR", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/** "3 de setembro", from "2026-09-03", without shifting it through a zone. */
function longDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return LONG_DAY.format(new Date(Date.UTC(year!, month! - 1, day!)));
}

/**
 * One sentence with what the chart shows, for everyone: a screen reader gets
 * the chart's facts from it, and a sighted reader gets the number the chart
 * only implies.
 */
function perDaySummary(stats: DashboardStats): string {
  const total = plural(stats.documentsInPeriod, "documento", "documentos");
  const peak = busiestDay(stats.perDay);
  if (peak === null) return `Nenhum documento nos últimos ${stats.days} dias.`;
  return (
    `${total} nos últimos ${stats.days} dias; o dia com mais foi ` +
    `${longDay(peak.date)}, com ${peak.documents}.`
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("pt-BR")} ${count === 1 ? one : many}`;
}

// ----- templates ranked ------------------------------------------------------

/**
 * The templates used most in the window.
 *
 * A list with proportional bars rather than a chart: each row has to be a real
 * link to its template, and a chart library's bars are not links a keyboard or
 * a screen reader can follow.
 */
function TopTemplates({ stats }: { readonly stats: DashboardStats }) {
  const most = stats.topTemplates[0]?.documents ?? 0;

  return (
    <section
      aria-labelledby="top-templates-title"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4 md:px-5"
    >
      <h2 id="top-templates-title" className="text-sm font-semibold">
        Modelos mais usados em {stats.days} dias
      </h2>
      {stats.topTemplates.length === 0 ? (
        <p className="text-caption text-muted-foreground">
          Nenhum documento gerado neste período.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {stats.topTemplates.map((usage) => (
            <li key={usage.templateId} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-small">
                {usage.deleted ? (
                  <span className="min-w-0 truncate text-muted-foreground">
                    {usage.name} <span className="text-faint italic">(excluído)</span>
                  </span>
                ) : (
                  <Link
                    to="/templates/$templateId"
                    params={{ templateId: usage.templateId }}
                    className="min-w-0 truncate hover:underline"
                  >
                    {usage.name}
                  </Link>
                )}
                {/*
                  The count opens Documentos filtered to this template, the
                  place to see which documents those are. Deleted templates
                  too: their documents stay in the history.
                */}
                <Link
                  to="/documentos"
                  search={{ modelo: usage.templateId }}
                  aria-label={`Ver os documentos de ${usage.name}`}
                  className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground hover:text-foreground hover:underline"
                >
                  {plural(usage.documents, "documento", "documentos")}
                </Link>
              </div>
              <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-docs"
                  style={{ width: `${most === 0 ? 0 : (usage.documents / most) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ----- recent documents ------------------------------------------------------

function RecentDocuments({ recent }: { readonly recent: readonly DocumentListItem[] }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onDownload(id: string) {
    setSaving(id);
    setFailure(null);
    try {
      const downloaded = await downloadDocument({ data: id });
      if (downloaded.ok) {
        saveFile(downloaded.value.filename, downloaded.value.contentType, downloaded.value.bytes);
        return;
      }
      setFailure(downloaded.failure);
    } finally {
      setSaving(null);
    }
  }

  const summary = summaryOf(failure);

  return (
    <section
      aria-labelledby="recent-title"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4 md:px-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="recent-title" className="text-sm font-semibold">
          Documentos recentes
        </h2>
        <Link to="/documentos" className="text-caption text-primary-text hover:underline">
          Ver todos
        </Link>
      </div>

      {summary != null && (
        <p role="alert" className="flex items-start gap-1.5 text-caption text-destructive">
          <IconAlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          <span>{summary}</span>
        </p>
      )}

      <ul className="flex flex-col divide-y divide-border">
        {recent.map(({ document, templateName }) => (
          <li key={document.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-small font-medium">{displayName(document.filename)}</span>
              <span className="truncate text-caption text-muted-foreground">
                {templateName ?? "modelo indisponível"} ·{" "}
                <time dateTime={document.createdAt.toISOString()}>
                  {relativeDate(document.createdAt)}
                </time>
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={saving === document.id}
              onClick={() => onDownload(document.id)}
              aria-label={`Baixar ${displayName(document.filename)}`}
              className="max-md:h-10"
            >
              <IconDownload data-icon="inline-start" aria-hidden="true" />
              {saving === document.id ? "Preparando…" : "Baixar"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ----- an empty account --------------------------------------------------------

/** What a new account sees instead of charts with nothing in them. */
function GettingStarted({ hasTemplates }: { readonly hasTemplates: boolean }) {
  const steps = [
    {
      done: hasTemplates,
      title: "Envie um modelo",
      body: "Um .docx com os campos marcados no formato {{.campo}}.",
      action: hasTemplates ? null : (
        <Button size="sm" nativeButton={false} render={<Link to="/templates/novo" />}>
          <IconUpload data-icon="inline-start" aria-hidden="true" />
          Enviar modelo
        </Button>
      ),
    },
    {
      done: false,
      title: "Preencha os campos",
      body: "Abra o modelo e complete os dados no próprio documento.",
      action: hasTemplates ? (
        <Button size="sm" nativeButton={false} render={<Link to="/templates" />}>
          <IconFilePlus data-icon="inline-start" aria-hidden="true" />
          Escolher modelo
        </Button>
      ) : null,
    },
    {
      done: false,
      title: "Baixe o documento",
      body: "Ele sai com a formatação do Word intacta e fica guardado em Documentos.",
      action: null,
    },
  ];

  return (
    <section
      aria-labelledby="getting-started-title"
      className="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-card px-4 py-4 md:px-5"
    >
      <div className="flex flex-col gap-1">
        <h2 id="getting-started-title" className="text-sm font-semibold">
          Primeiros passos
        </h2>
        <p className="text-caption text-muted-foreground">
          Os gráficos aparecem assim que o primeiro documento for gerado.
        </p>
      </div>
      <ol className="flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step.title} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-caption font-semibold",
                step.done
                  ? "border-success/40 bg-success/15 text-success-soft"
                  : "border-border-strong text-muted-foreground",
              )}
            >
              {step.done ? <IconCircleCheck className="size-4" /> : index + 1}
            </span>
            <span className="flex flex-1 flex-col items-start gap-1.5">
              <span className="text-small font-medium">
                {step.title}
                {step.done && <span className="sr-only"> (feito)</span>}
              </span>
              <span className="text-caption text-muted-foreground">{step.body}</span>
              {step.action}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
