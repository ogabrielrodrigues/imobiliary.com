import { useState, type ReactNode } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { IconArrowBackUp, IconArrowLeft, IconPlus, IconTrash } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import { PaymentDialog, RentStatusBadge, rentStatusNote } from "@/components/rents/payment-dialog";
import { SelectField } from "@/components/select-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney } from "@/domain/contract";
import { addressLine, addressPlace } from "@/domain/property";
import {
  CHARGE_DESTINATIONS,
  CHARGE_KINDS,
  chargeLabel,
  suggestedDestination,
  todayInSaoPaulo,
  validateCharge,
  type ChargeDestination,
  type ChargeInput,
  type ChargeKind,
  type RentDetail,
} from "@/domain/rent";
import { addCharge, getRent, removeCharge, reversePayment, setChargeDestination } from "@/server/rents";

const DESTINATION_OPTIONS: readonly (readonly [string, string])[] = CHARGE_DESTINATIONS.map(([value, label]) => [value, label]);

export const Route = createFileRoute("/_app/alugueis/$rentId")({
  loader: ({ params }) => getRent({ data: params.rentId }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title: `${loaderData?.ok ? `Aluguel de ${formatDate(loaderData.value.dueOn)}, contrato ${loaderData.value.contract.registry}` : "Aluguel"} | Imobiliary`,
      },
    ],
  }),
  component: RentPage,
});

/** One instalment: what is due, its charges, and its payments. */
function RentPage() {
  const result = Route.useLoaderData();
  const today = todayInSaoPaulo();

  const back = (
    <Link to="/alugueis" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
      <IconArrowLeft aria-hidden="true" className="size-4" />
      Aluguéis
    </Link>
  );

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {summaryOf(result.failure, { not_found: "Este aluguel não existe ou foi removido." })}
        </p>
      </div>
    );
  }

  const rent = result.value;
  const paid = rent.status === "paid";
  const hasPayments = rent.payments.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title-lg font-semibold tracking-[-0.015em]">
                Parcela {rent.sequence}, vence {formatDate(rent.dueOn)}
              </h1>
              <RentStatusBadge status={rent.status} partial={rent.partiallyPaid} />
            </div>
            <Link
              to="/contratos/$contractId"
              params={{ contractId: rent.contract.id }}
              className="text-small text-muted-foreground hover:text-foreground hover:underline"
            >
              Contrato {rent.contract.registry} · {addressLine(rent.contract.address)}, {addressPlace(rent.contract.address)}
            </Link>
            <span className="text-small text-muted-foreground">{rent.contract.tenantNames.join(", ")}</span>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {hasPayments && <ReversePayment rent={rent} />}
            {!paid && <PaymentDialog rent={rent} size="default" />}
          </div>
        </div>
      </header>

      <Section title="Valores">
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-small tabular-nums">
          <dt className="text-muted-foreground">Aluguel</dt>
          <dd className="text-right">{formatMoney(rent.amount)}</dd>
          {rent.charges.map((c) => (
            <Row key={c.id} label={c.description === "" ? chargeLabel(c.kind) : `${chargeLabel(c.kind)}: ${c.description}`}>
              {formatMoney(c.amount)}
            </Row>
          ))}
          <dt className="font-medium">A pagar</dt>
          <dd className="text-right font-medium">{formatMoney(rent.due)}</dd>
          {hasPayments && (
            <>
              <Row label="Multa e juros recebidos">{formatMoney(rent.lateFee)}</Row>
              {rent.incomeTaxWithheld !== "0.00" && (
                <Row label="IRRF retido pelo locatário">− {formatMoney(rent.incomeTaxWithheld)}</Row>
              )}
              <Row label={paid ? `Recebido, quitado em ${formatDate(rent.paidOn ?? "")}` : "Recebido até agora"}>
                {formatMoney(rent.amountPaid ?? "0.00")}
              </Row>
            </>
          )}
          {!paid && (
            <>
              {rent.partiallyPaid && <Row label="Aluguel e cobranças em aberto">{formatMoney(rent.outstanding)}</Row>}
              {rent.suggestedLateFee.total !== "0.00" && (
                <Row label={`Multa e juros se pago hoje (${rentStatusNote(rent, today)})`}>
                  {formatMoney(rent.suggestedLateFee.total)}
                </Row>
              )}
              {(rent.partiallyPaid || rent.suggestedLateFee.total !== "0.00") && (
                <>
                  <dt className="font-medium">Para quitar hoje</dt>
                  <dd className="text-right font-medium">{formatMoney(rent.owedToday)}</dd>
                </>
              )}
            </>
          )}
        </dl>
      </Section>

      {hasPayments && (
        <Section title={rent.payments.length === 1 ? "Pagamento" : "Pagamentos"}>
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {rent.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2 text-small tabular-nums">
                <span className="min-w-24">{formatDate(p.paidOn)}</span>
                <span className="font-medium">{formatMoney(p.amount)}</span>
                <span className="text-caption text-muted-foreground">
                  multa e juros {formatMoney(p.lateFee)}, aluguel e cobranças {formatMoney(p.principal)}
                  {p.waived !== "0.00" && `, dispensados ${formatMoney(p.waived)}`}
                  {p.incomeTaxWithheld !== "0.00" && `, IRRF ${formatMoney(p.incomeTaxWithheld)}`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Charges rent={rent} />
    </div>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const EMPTY_CHARGE: ChargeInput = { kind: "condominium", description: "", amount: "", destination: "third_party" };

function Charges({ rent }: { readonly rent: RentDetail }) {
  const router = useRouter();
  const [value, setValue] = useState<ChargeInput>(EMPTY_CHARGE);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Once money came in, every payment's split depends on the charges.
  const paid = rent.payments.length > 0;

  const local = attempted ? validateCharge(value) : [];
  const error = (field: string) => messageFor(failure, field) ?? local.find((p) => p.field === field)?.message;

  async function onAdd() {
    setAttempted(true);
    if (validateCharge(value).length > 0) return;
    setPending(true);
    setFailure(null);
    const result = await addCharge({ data: { id: rent.id, charge: value } });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setValue(EMPTY_CHARGE);
    setAttempted(false);
    await router.invalidate();
  }

  async function onDestination(chargeId: string, destination: ChargeDestination) {
    setFailure(null);
    const result = await setChargeDestination({ data: { id: rent.id, chargeId, destination } });
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await router.invalidate();
  }

  async function onRemove(chargeId: string) {
    setFailure(null);
    const result = await removeCharge({ data: { id: rent.id, chargeId } });
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await router.invalidate();
  }

  return (
    <Section title="Cobranças junto do aluguel">
      {rent.charges.length === 0 ? (
        <p className="text-small text-muted-foreground">Nenhuma cobrança além do aluguel.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rent.charges.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-small">
              <span className="min-w-0 flex-1 truncate">
                {chargeLabel(c.kind)}
                {c.description !== "" && <span className="text-muted-foreground">: {c.description}</span>}
              </span>
              <span className="tabular-nums">{formatMoney(c.amount)}</span>
              <select
                aria-label={`Destino de ${chargeLabel(c.kind)}`}
                value={c.destination}
                onChange={(event) => {
                  const next = event.currentTarget.value as ChargeDestination;
                  void onDestination(c.id, next);
                }}
                className="h-8 rounded-md border border-input-border bg-input px-2 text-small text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
              >
                {CHARGE_DESTINATIONS.map(([d, label]) => (
                  <option key={d} value={d}>
                    {label}
                  </option>
                ))}
              </select>
              {!paid && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remover ${chargeLabel(c.kind)}`}
                  onClick={() => void onRemove(c.id)}
                >
                  <IconTrash aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {paid ? (
        <p className="text-caption text-muted-foreground">
          Depois de um pagamento, só o destino de uma cobrança muda, e o repasse é refeito. Valor e tipo mudam estornando
          os pagamentos.
        </p>
      ) : (
        <form
          noValidate
          className="grid gap-3 sm:grid-cols-[9rem_1fr_8rem_9rem_auto] sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            void onAdd();
          }}
        >
          <SelectField
            label="Tipo"
            value={value.kind}
            onBlur={() => {}}
            onChange={(next) => {
              setFailure(null);
              const kind = next as ChargeKind;
              setValue((c) => ({ ...c, kind, destination: suggestedDestination(kind) }));
            }}
            options={CHARGE_KINDS}
          />
          <FormField
            name="description"
            label="Descrição"
            placeholder={value.kind === "other" ? "Taxa de lixo" : "Opcional"}
            autoComplete="off"
            value={value.description}
            error={error("description")}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setFailure(null);
              setValue((c) => ({ ...c, description: next }));
            }}
          />
          <FormField
            name="amount"
            label="Valor (R$)"
            placeholder="450,00"
            inputMode="decimal"
            autoComplete="off"
            value={value.amount}
            error={error("amount")}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setFailure(null);
              setValue((c) => ({ ...c, amount: next }));
            }}
          />
          <SelectField
            label="Destino"
            value={value.destination}
            onBlur={() => {}}
            onChange={(next) => {
              setFailure(null);
              setValue((c) => ({ ...c, destination: next as ChargeDestination }));
            }}
            options={DESTINATION_OPTIONS}
          />
          <Button type="submit" variant="secondary" disabled={pending} className="sm:mt-5.5">
            <IconPlus data-icon="inline-start" aria-hidden="true" />
            {pending ? "Adicionando..." : "Adicionar"}
          </Button>
        </form>
      )}
      <p className="text-caption text-muted-foreground">
        Terceiro: o escritório repassa ao condomínio ou à concessionária, fora do repasse e da taxa. Proprietário: entra no
        repasse e na base da taxa de administração.
      </p>
      {failure !== null && messageFor(failure, "description") === undefined && messageFor(failure, "amount") === undefined && (
        <p role="alert" className="text-small text-destructive-soft">
          {failure.kind === "validation" ? failure.fields[0]?.message : summaryOf(failure)}
        </p>
      )}
    </Section>
  );
}

function ReversePayment({ rent }: { readonly rent: RentDetail }) {
  const router = useRouter();
  const last = rent.payments.at(-1);
  const several = rent.payments.length > 1;
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onConfirm() {
    setPending(true);
    setFailure(null);
    const result = await reversePayment({ data: rent.id });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setOpen(false);
    await router.invalidate();
  }

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setFailure(null);
          setMounted(true);
          setOpen(true);
        }}
      >
        <IconArrowBackUp data-icon="inline-start" aria-hidden="true" />
        {several ? "Estornar o último pagamento" : "Estornar pagamento"}
      </Button>
      {mounted && (
        <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{several ? "Estornar o último pagamento?" : "Estornar o pagamento?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {last !== undefined && `O pagamento de ${formatDate(last.paidOn)}, de ${formatMoney(last.amount)}, é desfeito. `}
                {several
                  ? "Os anteriores continuam, e o aluguel fica em aberto pelo que faltar."
                  : "O aluguel volta a ficar em aberto, sem valor recebido."}{" "}
                O estorno fica na auditoria.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {failure !== null && (
              <p role="alert" className="text-small text-destructive-soft">
                {failure.kind === "validation" ? failure.fields[0]?.message : summaryOf(failure)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
                {pending ? "Estornando..." : "Estornar"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
