import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import { PropertyPicker } from "@/components/properties/property-picker";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatDate, formatMoney } from "@/domain/contract";
import {
  entryLabel,
  formatSigned,
  methodLabel,
  PAYOUT_METHODS,
  parseSigned,
  signedTotal,
  validateManualEntry,
  validatePayout,
  type LedgerEntry,
  type ManualEntryInput,
  type PayoutMethod,
} from "@/domain/payout";
import { addressLine, type PropertySummary } from "@/domain/property";
import { todayInSaoPaulo } from "@/domain/rent";
import { cn } from "@/lib/utils";
import { addLedgerEntry, createPayout, deleteLedgerEntry, personPayouts } from "@/server/payouts";

export const Route = createFileRoute("/_app/repasses/pessoa/$personId")({
  loader: ({ params }) => personPayouts({ data: params.personId }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.ok ? `Repasse de ${loaderData.value.ledger.person.name}` : "Repasse"} | Imobiliary` }],
  }),
  component: PersonPayoutsPage,
});

function PersonPayoutsPage() {
  const result = Route.useLoaderData();
  const back = (
    <Link to="/repasses" className="flex w-fit items-center gap-1 text-small text-muted-foreground hover:text-foreground">
      <IconArrowLeft aria-hidden="true" className="size-4" />
      Repasses
    </Link>
  );

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {summaryOf(result.failure, { not_found: "Esta pessoa não existe ou foi removida." })}
        </p>
      </div>
    );
  }

  const { ledger, payouts } = result.value;
  const balance = parseSigned(ledger.balance) ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-title-lg font-semibold tracking-[-0.015em]">{ledger.person.name}</h1>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Link
                to="/pessoas/$personId"
                params={{ personId: ledger.person.id }}
                className="text-small text-muted-foreground hover:text-foreground hover:underline"
              >
                Ver cadastro
              </Link>
              {ledger.person.kind === "individual" && (
                <Link
                  to="/repasses/pessoa/$personId/carne-leao"
                  params={{ personId: ledger.person.id }}
                  className="text-small text-muted-foreground hover:text-foreground hover:underline"
                >
                  Relatório para carnê-leão
                </Link>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-caption text-muted-foreground">Saldo a repassar</span>
            <span className={cn("text-title font-semibold tabular-nums", balance < 0 && "text-destructive-soft")}>
              {formatSigned(balance)}
            </span>
          </div>
        </div>
      </header>

      <Pending personId={ledger.person.id} pending={ledger.pending} today={ledger.today} />
      <ManualEntry personId={ledger.person.id} today={ledger.today} />

      <section aria-labelledby="history-title" className="flex flex-col gap-3">
        <h2 id="history-title" className="text-sm font-semibold">
          Repasses registrados
        </h2>
        {payouts.payouts.length === 0 ? (
          <p className="text-small text-muted-foreground">Nenhum repasse registrado para esta pessoa.</p>
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
            {payouts.payouts.map((p) => (
              <li key={p.id} className="border-b border-border last:border-b-0">
                <Link
                  to="/repasses/$payoutId"
                  params={{ payoutId: p.id }}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-row-hover"
                >
                  <span className="grow tabular-nums">
                    Nº {p.number} · {formatDate(p.paidOn)}
                    {p.method !== "" && <span className="text-muted-foreground"> · {methodLabel(p.method)}</span>}
                  </span>
                  <span className="font-medium tabular-nums">{formatMoney(p.total)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Section({ title, id, children }: { readonly title: string; readonly id: string; readonly children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4">
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The pending lines, ticked for the payout, and the payout itself. */
function Pending({
  personId,
  pending,
  today,
}: {
  readonly personId: string;
  readonly pending: readonly LedgerEntry[];
  readonly today: string;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(pending.map((e) => e.id)));
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<PayoutMethod>("");
  const [note, setNote] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [pendingSave, setPendingSave] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  // A new line, or one gone, resets the selection to everything pending.
  useEffect(() => {
    setChosen(new Set(pending.map((e) => e.id)));
  }, [pending]);

  const selected = pending.filter((e) => chosen.has(e.id));
  const total = signedTotal(selected);
  const input = { personId, paidOn, entryIds: selected.map((e) => e.id), method, note };
  const local = attempted ? validatePayout(input, selected, today) : [];
  const error = (field: string) => messageFor(failure, field) ?? local.find((p) => p.field === field)?.message;

  function toggle(id: string, on: boolean) {
    setFailure(null);
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function onRemove(id: string) {
    setFailure(null);
    const result = await deleteLedgerEntry({ data: id });
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await router.invalidate();
  }

  async function onSave() {
    setAttempted(true);
    if (validatePayout(input, selected, today).length > 0) return;
    setPendingSave(true);
    setFailure(null);
    const result = await createPayout({ data: input });
    setPendingSave(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await navigate({ to: "/repasses/$payoutId", params: { payoutId: result.value.id } });
  }

  if (pending.length === 0) {
    return (
      <Section title="Lançamentos pendentes" id="pending-title">
        <p className="text-small text-muted-foreground">Nada a repassar agora.</p>
      </Section>
    );
  }

  const allChosen = selected.length === pending.length;

  return (
    <Section title="Lançamentos pendentes" id="pending-title">
      <div className="flex items-center gap-2.5">
        <Checkbox
          id="choose-all"
          checked={allChosen}
          onCheckedChange={(checked) => {
            setFailure(null);
            setChosen(new Set(checked === true ? pending.map((e) => e.id) : []));
          }}
        />
        <Label htmlFor="choose-all" className="text-small font-normal">
          Marcar todos
        </Label>
      </div>

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {pending.map((e) => {
          const cents = parseSigned(e.signed) ?? 0;
          return (
            <li key={e.id} className="flex items-start gap-3 px-3 py-2.5 text-small">
              <Checkbox
                id={`entry-${e.id}`}
                className="mt-0.5"
                checked={chosen.has(e.id)}
                onCheckedChange={(checked) => toggle(e.id, checked === true)}
              />
              <Label htmlFor={`entry-${e.id}`} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 font-normal">
                <span>{entryLabel(e)}</span>
                <span className="text-caption text-muted-foreground">
                  {formatDate(e.occurredOn)}
                  {e.address !== null && ` · ${addressLine(e.address)}`}
                  {e.registry !== "" && ` · contrato ${e.registry}`}
                </span>
              </Label>
              <span className={cn("tabular-nums", cents < 0 && "text-destructive-soft")}>{formatSigned(cents)}</span>
              {(e.kind === "debit" || e.kind === "credit") && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Excluir ${e.description}`}
                  onClick={() => void onRemove(e.id)}
                >
                  <IconTrash aria-hidden="true" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      <form
        noValidate
        className="flex flex-col gap-3 border-t border-border pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField
            name="paid_on"
            label="Data da transferência"
            type="date"
            max={today}
            value={paidOn}
            error={error("paidOn")}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setFailure(null);
              setPaidOn(next);
            }}
          />
          <SelectField
            label="Forma"
            value={method}
            onBlur={() => {}}
            onChange={(next) => setMethod(next as PayoutMethod)}
            options={PAYOUT_METHODS}
          />
          <FormField
            name="note"
            label="Observação"
            placeholder="Opcional"
            autoComplete="off"
            value={note}
            error={error("note")}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setNote(next);
            }}
          />
        </div>
        {(error("entryIds") ?? error("form")) !== undefined && (
          <p role="alert" className="text-small text-destructive-soft">
            {error("entryIds") ?? error("form")}
          </p>
        )}
        {failure !== null && failure.kind !== "validation" && (
          <p role="alert" className="text-small text-destructive-soft">
            {summaryOf(failure, { conflict: "Algum lançamento acabou de entrar em outro repasse. Recarregue a página." })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pendingSave}>
            {pendingSave ? "Registrando..." : `Registrar repasse de ${formatSigned(total)}`}
          </Button>
          <span className="text-caption text-muted-foreground">
            {selected.length === 1 ? "1 lançamento marcado" : `${selected.length} lançamentos marcados`}. Registre depois de
            transferir.
          </span>
        </div>
      </form>
    </Section>
  );
}

const EMPTY_ENTRY = (today: string): ManualEntryInput => ({
  kind: "debit",
  amount: "",
  description: "",
  occurredOn: today,
  propertyId: "",
});

/** A debit or credit the office types: an expense it paid, anything owed. */
function ManualEntry({ personId, today }: { readonly personId: string; readonly today: string }) {
  const router = useRouter();
  const [value, setValue] = useState<ManualEntryInput>(EMPTY_ENTRY(today));
  const [property, setProperty] = useState<PropertySummary | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const local = attempted ? validateManualEntry(value, today) : [];
  const error = (field: string) => messageFor(failure, field) ?? local.find((p) => p.field === field)?.message;

  function change(patch: Partial<ManualEntryInput>) {
    setFailure(null);
    setValue((current) => ({ ...current, ...patch }));
  }

  async function onAdd() {
    setAttempted(true);
    if (validateManualEntry(value, today).length > 0) return;
    setPending(true);
    setFailure(null);
    const result = await addLedgerEntry({ data: { personId, entry: value } });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setValue(EMPTY_ENTRY(today));
    setProperty(null);
    setAttempted(false);
    await router.invalidate();
  }

  return (
    <Section title="Lançar débito ou crédito" id="manual-title">
      <p className="font-reading text-small text-muted-foreground">
        Uma despesa que o escritório pagou pelo proprietário, como um conserto, entra como débito e é descontada no
        próximo repasse. Um crédito soma ao saldo.
      </p>
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void onAdd();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[9rem_1fr_9rem_10rem]">
          <SelectField
            label="Tipo"
            value={value.kind}
            onBlur={() => {}}
            onChange={(next) => change({ kind: next === "credit" ? "credit" : "debit" })}
            options={[
              ["debit", "Débito"],
              ["credit", "Crédito"],
            ]}
          />
          <FormField
            name="description"
            label="Descrição"
            placeholder="Conserto do chuveiro"
            autoComplete="off"
            value={value.description}
            error={error("description")}
            onChange={(event) => {
              const next = event.currentTarget.value;
              change({ description: next });
            }}
          />
          <FormField
            name="amount"
            label="Valor (R$)"
            placeholder="250,00"
            inputMode="decimal"
            autoComplete="off"
            value={value.amount}
            error={error("amount")}
            onChange={(event) => {
              const next = event.currentTarget.value;
              change({ amount: next });
            }}
          />
          <FormField
            name="occurred_on"
            label="Data"
            type="date"
            max={today}
            value={value.occurredOn}
            error={error("occurredOn")}
            onChange={(event) => {
              const next = event.currentTarget.value;
              change({ occurredOn: next });
            }}
          />
        </div>
        <PropertyPicker
          label="Imóvel"
          hint="Opcional. Aparece no demonstrativo junto dos lançamentos desse imóvel."
          error={error("propertyId")}
          chosen={property}
          onChange={(chosen) => {
            setProperty(chosen);
            change({ propertyId: chosen?.id ?? "" });
          }}
        />
        {failure !== null && failure.kind !== "validation" && (
          <p role="alert" className="text-small text-destructive-soft">
            {summaryOf(failure)}
          </p>
        )}
        <Button type="submit" variant="secondary" disabled={pending} className="self-start">
          {pending ? "Lançando..." : "Lançar"}
        </Button>
      </form>
    </Section>
  );
}
