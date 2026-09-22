import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { IconCash } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure, type Result } from "@/application/result";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDate, formatMoney, formatMoneyInput, parseMoney } from "@/domain/contract";
import { Label } from "@/components/ui/label";
import { addressLine } from "@/domain/property";
import {
  RENT_STATUS,
  amountReceived,
  splitPartial,
  todayInSaoPaulo,
  validatePayment,
  type PaymentInput,
  type PaymentPreview,
  type RentStatus,
  type RentSummary,
} from "@/domain/rent";
import { cn } from "@/lib/utils";
import { payRent, previewPayment } from "@/server/rents";

/** A rent's situation today, in words and not in colour alone. */
export function RentStatusBadge({
  status,
  partial = false,
  className,
}: {
  readonly status: RentStatus;
  /** Money came in and something is still open. */
  readonly partial?: boolean;
  readonly className?: string;
}) {
  const badge = cn(
    "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 font-mono text-micro tracking-[0.1em] uppercase",
  );
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5", className)}>
      <span
        className={cn(
          badge,
          status === "paid" && "border-success/35 bg-success/5 text-success-soft",
          status === "overdue" && "border-destructive/35 bg-destructive/5 text-destructive-soft",
          status === "pending" && "border-border text-muted-foreground",
        )}
      >
        {RENT_STATUS[status]}
      </span>
      {partial && <span className={cn(badge, "border-docs/35 bg-docs/5 text-docs-soft")}>Parcial</span>}
    </span>
  );
}

/**
 * Recording a payment, of everything or of a part.
 *
 * The API computes what is owed on the day typed, shown as it changes; the
 * office can type over the interest and penalty (0 forgives them). Paying
 * everything, the amount received is not typed: it follows what is open, the
 * late fee and the income tax a company tenant withheld. Receiving a part,
 * the amount is typed, and the dialog shows what it settles: the interest and
 * penalty first, then the rent and charges.
 */
export function PaymentDialog({
  rent,
  size = "sm",
  onPaid,
}: {
  readonly rent: RentSummary;
  readonly size?: "sm" | "default";
  readonly onPaid?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Mounted only once asked for: a Base UI dialog cannot render on the server.
  const [mounted, setMounted] = useState(false);
  const [value, setValue] = useState<PaymentInput>({ paidOn: "", amount: "", lateFee: "", incomeTax: "" });
  const [withheld, setWithheld] = useState(false);
  const [partial, setPartial] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [preview, setPreview] = useState<Result<PaymentPreview> | null>(null);

  const today = todayInSaoPaulo();
  const { paidOn } = value;
  useEffect(() => {
    if (!open || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || paidOn > today) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await previewPayment({ data: { id: rent.id, paidOn } });
      if (!cancelled) setPreview(result);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, paidOn, rent.id, today]);

  // What the tenant can still withhold: the rent less earlier withholdings.
  const taxRoom = formatMoneyInput(Math.max((parseMoney(rent.amount) ?? 0) - (parseMoney(rent.incomeTaxWithheld) ?? 0), 0));
  const payment: PaymentInput = { ...value, amount: partial ? value.amount : "", incomeTax: withheld ? value.incomeTax : "" };
  const problems = () => {
    const found = validatePayment(payment, today, taxRoom);
    if (partial && value.amount.trim() === "") found.push({ field: "amount", message: "Informe o valor recebido." });
    return found;
  };
  const local = attempted ? problems() : [];
  const error = (field: string) => messageFor(failure, field) ?? local.find((p) => p.field === field)?.message;
  const ready = preview?.ok ? preview.value : null;

  // What will be recorded: the late fee typed or computed, less the tax.
  const fee = value.lateFee.trim() !== "" ? value.lateFee : ready ? formatMoneyInput(parseMoney(ready.lateFee.total) ?? 0) : null;
  const tax = payment.incomeTax;
  const openAmount = ready?.principal ?? rent.outstanding;
  const received = fee === null ? null : amountReceived(openAmount, fee, tax);
  const split = partial && fee !== null && value.amount.trim() !== "" ? splitPartial(value.amount, tax, fee, openAmount) : null;
  const taxCents = tax.trim() === "" ? 0 : parseMoney(tax);

  function change(patch: Partial<PaymentInput>) {
    setFailure(null);
    setValue((current) => ({ ...current, ...patch }));
  }

  async function onSave() {
    setAttempted(true);
    if (problems().length > 0) return;
    setPending(true);
    setFailure(null);
    const result = await payRent({ data: { id: rent.id, payment } });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setOpen(false);
    onPaid?.();
    await router.invalidate();
  }

  return (
    <>
      <Button
        variant={size === "sm" ? "secondary" : "default"}
        size={size}
        onClick={() => {
          setValue({ paidOn: today, amount: "", lateFee: "", incomeTax: "" });
          setWithheld(false);
          setPartial(false);
          setAttempted(false);
          setFailure(null);
          setPreview(null);
          setMounted(true);
          setOpen(true);
        }}
      >
        <IconCash data-icon="inline-start" aria-hidden="true" />
        Registrar pagamento
      </Button>

      {mounted && (
        <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <DialogContent showCloseButton={false} className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Registrar pagamento</DialogTitle>
              <DialogDescription>
                {addressLine(rent.contract.address)}, parcela {rent.sequence}, vencimento em {formatDate(rent.dueOn)}.
              </DialogDescription>
            </DialogHeader>

            <form
              noValidate
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void onSave();
              }}
            >
              <div className="sm:w-1/2">
                <FormField
                  name="paid_on"
                  label="Data do pagamento"
                  type="date"
                  max={today}
                  value={value.paidOn}
                  error={error("paidOn")}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    change({ paidOn: next });
                  }}
                />
              </div>

              <dl aria-live="polite" className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-md border border-border px-3 py-2.5 text-small tabular-nums">
                <dt className="text-muted-foreground">
                  Aluguel{rent.chargesTotal !== "0.00" && " e cobranças"}
                  {rent.partiallyPaid && " em aberto"}
                </dt>
                <dd className="text-right">{formatMoney(openAmount)}</dd>
                {ready !== null && ready.lateFee.daysLate > 0 && (
                  <>
                    {ready.lateFee.penalty !== "0.00" && (
                      <>
                        <dt className="text-muted-foreground">Multa</dt>
                        <dd className="text-right">{formatMoney(ready.lateFee.penalty)}</dd>
                      </>
                    )}
                    <dt className="text-muted-foreground">
                      Juros{rent.partiallyPaid ? " em aberto" : ` de ${ready.lateFee.daysLate} ${ready.lateFee.daysLate === 1 ? "dia" : "dias"}`}
                    </dt>
                    <dd className="text-right">{formatMoney(ready.lateFee.interest)}</dd>
                  </>
                )}
                {ready !== null && ready.lateFee.daysLate === 0 && (
                  <>
                    <dt className="text-muted-foreground">Multa e juros</dt>
                    <dd className="text-right">nenhum, pago em dia</dd>
                  </>
                )}
                {withheld && taxCents !== null && taxCents > 0 && (
                  <>
                    <dt className="text-muted-foreground">IRRF retido pelo locatário</dt>
                    <dd className="text-right">− R$ {formatMoneyInput(taxCents)}</dd>
                  </>
                )}
                {!partial && received !== null && (
                  <>
                    <dt className="font-medium">Valor recebido</dt>
                    <dd className="text-right font-medium">R$ {formatMoneyInput(received)}</dd>
                  </>
                )}
                {split !== null && !split.exceeds && (
                  <>
                    <dt className="text-muted-foreground">Quita de multa e juros</dt>
                    <dd className="text-right">R$ {formatMoneyInput(split.lateFee)}</dd>
                    <dt className="text-muted-foreground">Abate do aluguel{rent.chargesTotal !== "0.00" && " e cobranças"}</dt>
                    <dd className="text-right">R$ {formatMoneyInput(split.principal)}</dd>
                    <dt className="font-medium">Fica em aberto</dt>
                    <dd className="text-right font-medium">R$ {formatMoneyInput(split.remaining)}</dd>
                  </>
                )}
              </dl>

              <div className="flex items-start gap-2.5">
                <Checkbox
                  id={`partial-${rent.id}`}
                  checked={partial}
                  onCheckedChange={(checked) => {
                    setFailure(null);
                    setPartial(checked === true);
                  }}
                />
                <Label htmlFor={`partial-${rent.id}`} className="flex flex-col items-start gap-0.5 text-small font-normal">
                  Receber só uma parte
                  <span className="text-caption text-muted-foreground">
                    Quita primeiro multa e juros, depois o aluguel. O que faltar continua em aberto, com juros sobre o restante.
                  </span>
                </Label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {partial && (
                  <FormField
                    name="amount"
                    label="Valor recebido (R$)"
                    placeholder="800,00"
                    inputMode="decimal"
                    autoComplete="off"
                    value={value.amount}
                    error={error("amount") ?? (split?.exceeds === true ? "O valor passa do que falta." : undefined)}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      change({ amount: next });
                    }}
                  />
                )}
                <FormField
                  name="late_fee"
                  label="Multa e juros (R$)"
                  placeholder={ready ? formatMoney(ready.lateFee.total).replace("R$ ", "") : "0,00"}
                  inputMode="decimal"
                  autoComplete="off"
                  hint="Vazio para o calculado. 0 para dispensar."
                  value={value.lateFee}
                  error={error("lateFee")}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    change({ lateFee: next });
                  }}
                />
                {withheld && (
                  <FormField
                    name="income_tax_withheld"
                    label="IRRF retido (R$)"
                    placeholder="0,00"
                    inputMode="decimal"
                    autoComplete="off"
                    hint="O valor que o locatário descontou e recolheu."
                    value={value.incomeTax}
                    error={error("incomeTax")}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      change({ incomeTax: next });
                    }}
                  />
                )}
              </div>

              <div className="flex items-start gap-2.5">
                <Checkbox
                  id={`withheld-${rent.id}`}
                  checked={withheld}
                  onCheckedChange={(checked) => {
                    setFailure(null);
                    setWithheld(checked === true);
                  }}
                />
                <Label htmlFor={`withheld-${rent.id}`} className="flex flex-col items-start gap-0.5 text-small font-normal">
                  O locatário é empresa e reteve imposto de renda
                  <span className="text-caption text-muted-foreground">
                    O valor retido conta como pago, e o repasse desconta o IRRF.
                  </span>
                </Label>
              </div>

              {error("form") !== undefined && (
                <p role="alert" className="text-small text-destructive-soft">
                  {error("form")}
                </p>
              )}

              {failure !== null && failure.kind !== "validation" && (
                <p role="alert" className="text-small text-destructive-soft">
                  {summaryOf(failure, {
                    conflict: "Este aluguel já foi pago. Recarregue a página para ver o pagamento registrado.",
                  })}
                </p>
              )}

              <DialogFooter className="-mx-4 -mb-4 mt-2">
                <Button type="button" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Registrando..." : "Registrar pagamento"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** A status line for lists: the status, and how many days late. */
export function rentStatusNote(rent: RentSummary, today: string): string {
  if (rent.status === "paid" && rent.paidOn !== null) return `Pago em ${formatDate(rent.paidOn)}`;
  if (rent.status === "overdue") {
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${rent.dueOn}T00:00:00Z`)) / 86_400_000);
    return `${days} ${days === 1 ? "dia" : "dias"} em atraso`;
  }
  return RENT_STATUS[rent.status];
}
