const RELATIVE = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
const ABSOLUTE = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "há 2 dias", "ontem", "agora mesmo".
 *
 * Past a month it switches to a date: "há 7 semanas" is harder to place than
 * the day itself.
 */
export function relativeDate(value: Date, now = new Date()): string {
  const elapsed = now.getTime() - value.getTime();

  if (elapsed < MINUTE) return "agora mesmo";
  if (elapsed < HOUR)
    return RELATIVE.format(-Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return RELATIVE.format(-Math.floor(elapsed / HOUR), "hour");
  if (elapsed < 30 * DAY)
    return RELATIVE.format(-Math.floor(elapsed / DAY), "day");

  return ABSOLUTE.format(value);
}

/**
 * "09/09, 14:12".
 *
 * The pt-BR locale already puts the comma in, so nothing is added here — an
 * earlier version inserted one and produced "09/09,, 14:12".
 */
export function shortDateTime(value: Date): string {
  return ABSOLUTE.format(value);
}
