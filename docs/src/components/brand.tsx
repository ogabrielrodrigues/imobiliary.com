import { cn } from "cn";

/**
 * The wordmark.
 *
 * Always lowercase. "imobiliary" inherits the surrounding text colour, and
 * "docs" always carries the subapplication colour — it never appears alone.
 */
export function Brand({
  variant = "horizontal",
  className,
}: {
  /** `stacked` is for the narrow sidebar; `horizontal` everywhere else. */
  readonly variant?: "horizontal" | "stacked";
  readonly className?: string;
}) {
  if (variant === "stacked") {
    return (
      <span
        className={cn(
          "flex flex-col text-[20px] leading-[1.05] font-semibold tracking-[-0.02em]",
          className,
        )}
      >
        <span>imobiliary</span>
        <span className="tracking-[0.02em] text-docs">docs</span>
      </span>
    );
  }

  return (
    <span
      className={cn("font-semibold tracking-[-0.02em]", className)}
    >
      imobiliary <span className="text-docs">docs</span>
    </span>
  );
}
