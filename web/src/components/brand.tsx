import { Link } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

/**
 * The wordmark, always lowercase.
 *
 * One component, used everywhere it appears. The document platform once grew a
 * private copy of its own and the two drifted apart in size; if a wordmark
 * ever looks wrong on one screen only, look for a second copy before editing
 * this one.
 */
export function Brand({
  to,
  className,
}: Readonly<{ to?: "/" | "/dashboard"; className?: string }>) {
  const mark = (
    <span className={cn("font-semibold tracking-tight text-title-sm lowercase", className)}>
      imobiliary
    </span>
  );
  return to === undefined ? (
    mark
  ) : (
    <Link to={to} className="rounded-sm focus-visible:outline-none">
      {mark}
    </Link>
  );
}
