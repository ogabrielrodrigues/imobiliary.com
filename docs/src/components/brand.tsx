import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/** Where the wordmark leads. A route the router knows, never a bare string. */
type BrandDestination = "/" | "/templates";

/**
 * The wordmark.
 *
 * Always lowercase. "imobiliary" inherits the surrounding text colour, and
 * "docs" always carries the subapplication colour — it never appears alone.
 *
 * Give it `to` and it becomes the way back to wherever "home" is for the
 * surface it sits on: the model list inside the app, the landing page outside
 * it. A `Link` rather than an anchor, so navigation stays client-side and the
 * router checks the destination at compile time.
 */
export function Brand({
  to,
  className,
}: {
  /** Omit to render plain text, for the places the mark is decoration only. */
  readonly to?: BrandDestination;
  readonly className?: string;
}) {
  const wordmark = (
    <>
      imobiliary <span className="text-docs">docs</span>
    </>
  );

  const classes = cn("font-semibold tracking-[-0.02em]", className);

  if (to === undefined) {
    return <span className={classes}>{wordmark}</span>;
  }

  return (
    <Link
      to={to}
      aria-label="Imobiliary Docs, página inicial"
      className={cn(classes, "rounded-md transition-opacity hover:opacity-80")}
    >
      {wordmark}
    </Link>
  );
}
