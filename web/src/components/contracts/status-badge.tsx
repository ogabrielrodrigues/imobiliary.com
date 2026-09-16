import { STATUS_LABELS, type ContractStatus } from "@/domain/contract";
import { cn } from "@/lib/utils";

/** A contract's situation today, in words and not in colour alone. */
export function ContractStatusBadge({ status, className }: { readonly status: ContractStatus; readonly className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 font-mono text-micro tracking-[0.1em] uppercase",
        status === "active" && "border-success/35 bg-success/5 text-success-soft",
        status === "upcoming" && "border-docs/35 bg-docs/5 text-docs-soft",
        (status === "expired" || status === "terminated") && "border-border text-muted-foreground",
        className,
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
