/**
 * The figures behind the dashboard, as the API reports them, and the few rules
 * the interface applies to them.
 */

/** The windows the API offers, in days. */
export const STATS_PERIODS = [7, 30, 90] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

export const DEFAULT_STATS_PERIOD: StatsPeriod = 30;

/**
 * The zone used when the viewer's is not known: a server render has no browser
 * to ask. The product serves Brazilian brokers, so this is right for nearly
 * every first load, and every navigation after it uses the browser's own zone.
 */
export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

export function isStatsPeriod(value: unknown): value is StatsPeriod {
  return STATS_PERIODS.includes(value as StatsPeriod);
}

/** Documents generated on one calendar day, "2026-09-11", in the report's zone. */
export interface DayCount {
  readonly date: string;
  readonly documents: number;
}

/** A template ranked by the documents made from it in the window. */
export interface TemplateUsage {
  readonly templateId: string;
  readonly name: string;
  /** The template was deleted since; its documents still count. */
  readonly deleted: boolean;
  readonly documents: number;
}

export interface DashboardStats {
  readonly days: StatsPeriod;
  readonly timeZone: string;
  readonly templates: number;
  readonly documents: number;
  readonly documentsInPeriod: number;
  readonly documentsPreviousPeriod: number;
  readonly perDay: readonly DayCount[];
  readonly topTemplates: readonly TemplateUsage[];
}

/**
 * The change from the previous window to this one, as a rounded percentage, or
 * null when the previous window had nothing: growth from zero is not a number
 * anyone can read.
 */
export function periodChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** The day with the most documents; the earliest wins a tie. Null when none has any. */
export function busiestDay(perDay: readonly DayCount[]): DayCount | null {
  let best: DayCount | null = null;
  for (const day of perDay) {
    if (day.documents > 0 && (best === null || day.documents > best.documents)) {
      best = day;
    }
  }
  return best;
}
