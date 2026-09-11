import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DayCount } from "@/domain/stats";
import { useReducedMotion } from "@/lib/reduced-motion";

/*
  The series colour is a token, so it follows the theme: bright amber in
  Escuro, the dark amber in Claro and Papel. A chart mark needs 3:1 against its
  ground (1.4.11), and the contrast test holds --primary-text to 4.5:1 as text
  in every palette, which is more.
*/
const CONFIG = {
  documents: { label: "Documentos", color: "var(--primary-text)" },
} satisfies ChartConfig;

/** "2026-09-11" as "11/09", without a Date: a day has no time zone to shift. */
export function dayLabel(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

/**
 * Documents per day across the window, as an area.
 *
 * Decorative to a screen reader, which gets the same facts from the summary
 * sentence the page sets beside it; the chart library's own keyboard layer
 * stays on for anyone who explores it with arrows.
 */
export function DocumentsChart({ perDay }: { readonly perDay: readonly DayCount[] }) {
  const reduceMotion = useReducedMotion();
  const data = perDay.map((d) => ({ label: dayLabel(d.date), documents: d.documents }));

  return (
    <ChartContainer config={CONFIG} className="aspect-auto h-56 w-full" aria-hidden="true">
      <AreaChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} accessibilityLayer>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
        <YAxis allowDecimals={false} width={28} tickLine={false} axisLine={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
        <Area
          dataKey="documents"
          type="monotone"
          stroke="var(--color-documents)"
          fill="var(--color-documents)"
          fillOpacity={0.18}
          strokeWidth={2}
          isAnimationActive={!reduceMotion}
        />
      </AreaChart>
    </ChartContainer>
  );
}
