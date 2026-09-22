import { formatMoney } from "@/domain/contract";
import {
  entryLabel,
  formatSigned,
  groupByProperty,
  parseSigned,
  signedTotal,
  totalsByKind,
  type EntryKind,
  type PayoutDetail,
} from "@/domain/payout";
import { addressLine, addressPlace } from "@/domain/property";
import { cn } from "@/lib/utils";

/** The order a summary lists the kinds in: what is owed, then what is deducted. */
/** A summary adds lines up, so it names each kind in the plural. */
const SUMMARY_LABELS: Readonly<Record<EntryKind, string>> = {
  rent: "Aluguéis",
  late_fee: "Multas e juros",
  charge: "Cobranças do proprietário",
  credit: "Créditos",
  admin_fee: "Taxa de administração",
  income_tax: "IRRF retido pelo locatário",
  debit: "Débitos",
};

export const SUMMARY_KINDS: readonly EntryKind[] = ["rent", "late_fee", "charge", "credit", "admin_fee", "income_tax", "debit"];

/** The lines by property, each with its subtotal, and a summary by kind. */
export function Statement({ payout }: { readonly payout: PayoutDetail }) {
  const totals = totalsByKind(payout.entries);
  return (
    <div className="flex flex-col gap-4">
      {groupByProperty(payout.entries).map((group) => (
        <section
          key={group.propertyId ?? "avulsos"}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4 print:break-inside-avoid"
        >
          <h2 className="text-sm font-semibold">
            {group.address === null ? "Lançamentos avulsos" : `${addressLine(group.address)}, ${addressPlace(group.address)}`}
          </h2>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-small tabular-nums">
            {group.entries.map((e) => {
              const cents = parseSigned(e.signed) ?? 0;
              return (
                <Line key={e.id} label={entryLabel(e)} negative={cents < 0}>
                  {formatSigned(cents)}
                </Line>
              );
            })}
            <dt className="font-medium">Subtotal</dt>
            <dd className="text-right font-medium">{formatSigned(signedTotal(group.entries))}</dd>
          </dl>
        </section>
      ))}

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4 print:break-inside-avoid">
        <h2 className="text-sm font-semibold">Resumo</h2>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-small tabular-nums">
          {SUMMARY_KINDS.filter((k) => totals[k] > 0).map((k) => {
            const deducted = k === "admin_fee" || k === "income_tax" || k === "debit";
            return (
              <Line key={k} label={SUMMARY_LABELS[k]} negative={deducted}>
                {formatSigned(deducted ? -totals[k] : totals[k])}
              </Line>
            );
          })}
          <dt className="font-semibold">Total repassado</dt>
          <dd className="text-right font-semibold">{formatMoney(payout.total)}</dd>
        </dl>
      </section>
    </div>
  );
}

function Line({ label, negative, children }: { readonly label: string; readonly negative: boolean; readonly children: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("text-right", negative && "text-destructive-soft print:text-foreground")}>{children}</dd>
    </>
  );
}

