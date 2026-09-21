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
export function RentStatusBadge({ status, className }: { readonly status: RentStatus; readonly className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 font-mono text-micro tracking-[0.1em] uppercase",
        status === "paid" && "border-success/35 bg-success/5 text-success-soft",
        status === "overdue" && "border-destructive/35 bg-destructive/5 text-destructive-soft",
        status === "pending" && "border-border text-muted-foreground",
        className,
      )}
    >
      {RENT_STATUS[status]}
    </span>
  );
}

/**
 * Recording a payment in full.
 *
 * The API computes the late fee for the day typed, shown as it changes; the
 * office can type over it (a waived fee is 0). The amount received is not
 * typed: it is what the owners' payout is made of, so it follows the rent,
 * the charges, the late fee and the income tax a company tenant withheld.
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
  const [value, setValue] = useState<PaymentInput>({ paidOn: "", lateFee: "", incomeTax: "" });
  const [withheld, setWithheld] = useState(false);
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

  const local = attempted ? validatePayment(value, today, rent.amount) : [];
  const error = (field: string) => messageFor(failure, field) ?? local.find((p) => p.field === field)?.message;
  const ready = preview?.ok ? preview.value : null;

  // What will be recorded: the late fee typed or computed, less the tax.
  const fee = value.lateFee.trim() !== "" ? value.lateFee : ready ? formatMoneyInput(parseMoney(ready.lateFee.total) ?? 0) : null;
  const tax = withheld ? value.incomeTax : "";
  const received = fee === null ? null : amountReceived(rent.due, fee, tax);
  const taxCents = tax.trim() === "" ? 0 : parseMoney(tax);

  function change(patch: Partial<PaymentInput>) {
    setFailure(null);
    setValue((current) => ({ ...current, ...patch }));
  }

  async function onSave() {
    setAttempted(true);
    const payment = { ...value, incomeTax: withheld ? value.incomeTax : "" };
    if (validatePayment(payment, today, rent.amount).length > 0) return;
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
          setValue({ paidOn: today, lateFee: "", incomeTax: "" });
          setWithheld(false);
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
                {addressLine(rent.contract.address)}, parcela {rent.sequence}, vencimento em {formatDate(rent.dueOn)}. O
                pagamento é do valor inteiro.
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
                <dt className="text-muted-foreground">Aluguel{rent.chargesTotal !== "0.00" && " e cobranças"}</dt>
                <dd className="text-right">{formatMoney(rent.due)}</dd>
                {ready !== null && ready.lateFee.daysLate > 0 && (
                  <>
                    <dt className="text-muted-foreground">Multa</dt>
                    <dd className="text-right">{formatMoney(ready.lateFee.penalty)}</dd>
                    <dt className="text-muted-foreground">
                      Juros de {ready.lateFee.daysLate} {ready.lateFee.daysLate === 1 ? "dia" : "dias"}
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
                {received !== null && (
                  <>
                    <dt className="font-medium">Valor recebido</dt>
                    <dd className="text-right font-medium">R$ {formatMoneyInput(received)}</dd>
                  </>
                )}
              </dl>

              <div className="grid gap-4 sm:grid-cols-2">
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
                    O aluguel conta como pago inteiro, e o repasse desconta o IRRF.
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
