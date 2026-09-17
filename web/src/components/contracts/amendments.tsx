import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { IconArrowBackUp, IconTrendingUp } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure, type Result } from "@/application/result";
import { FormField } from "@/components/form-field";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  formatDate,
  formatMoney,
  formatMoneyInput,
  formatSignedPercent,
  indexLabel,
  NOTICES,
  parseMoney,
  parseSignedPercent,
  validateAmendment,
  type AmendmentInput,
  type AmendmentPreview,
  type Contract,
} from "@/domain/contract";
import { cn } from "@/lib/utils";
import { createAmendment, previewAmendment, undoAmendment } from "@/server/contracts";

/**
 * A contract's rent adjustments: the list, recording one, and undoing the last.
 *
 * Recording asks the API what the adjustment would do as the person types, so
 * the suggested rent, the instalments it reaches and the twelve-month notice
 * are on screen before anything is saved.
 */
export function ContractAmendments({ contract }: { readonly contract: Contract }) {
  const running = contract.terminatedOn === null;
  const last = contract.amendments.at(-1);

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">Reajustes</h2>
        {running && <AmendContract contract={contract} />}
      </div>

      {contract.amendments.length === 0 ? (
        <p className="text-small text-muted-foreground">
          {running
            ? "Nenhum reajuste registrado. O aluguel é o do contrato."
            : "Nenhum reajuste registrado."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-small tabular-nums">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1.5 pr-4 font-medium">A partir de</th>
                <th scope="col" className="py-1.5 pr-4 font-medium">Índice</th>
                <th scope="col" className="py-1.5 pr-4 text-right font-medium">Aluguel</th>
                <th scope="col" className="py-1.5"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody className="font-reading">
              {contract.amendments.map((a) => (
                <tr key={a.id} className="border-t border-border align-top">
                  <td className="py-1.5 pr-4">{formatDate(a.amendedOn)}</td>
                  <td className="py-1.5 pr-4">
                    {a.adjustmentIndex === "" ? "Sem índice" : indexLabel(a.adjustmentIndex)} {formatSignedPercent(a.indexRate)}%
                    {a.periodAcknowledgedAt !== null && (
                      <span className="block text-caption text-muted-foreground">antes de doze meses, com ciência</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 text-right">
                    {formatMoney(a.previousRent)} para {formatMoney(a.indexedRent)}
                  </td>
                  <td className="py-1 text-right">
                    {running && a.id === last?.id && <UndoAmendment contract={contract} amendmentId={a.id} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const EMPTY: AmendmentInput = { amendedOn: "", indexRate: "", indexedRent: "", acknowledgments: [] };

function AmendContract({ contract }: { readonly contract: Contract }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Mounted only once asked for: a Base UI dialog cannot render on the server.
  const [mounted, setMounted] = useState(false);
  const [value, setValue] = useState<AmendmentInput>(EMPTY);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [preview, setPreview] = useState<Result<AmendmentPreview> | null>(null);

  const request = (amendment: AmendmentInput) => ({
    id: contract.id,
    version: contract.version,
    startsOn: contract.startsOn,
    expiresOn: contract.expiresOn,
    amendment,
  });

  // The preview follows the day and the rate; the typed rent only changes
  // the sentence below it, which is computed here.
  const { amendedOn, indexRate } = value;
  useEffect(() => {
    if (!open) return;
    const probe = { ...EMPTY, amendedOn, indexRate };
    if (validateAmendment(probe, contract).length > 0) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await previewAmendment({ data: request(probe) });
      if (!cancelled) setPreview(result);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, amendedOn, indexRate, contract.version]);

  const local = attempted ? validateAmendment(value, contract) : [];
  const error = (field: string) => messageFor(failure, field) ?? local.find((p) => p.field === field)?.message;
  const ready = preview?.ok ? preview.value : null;
  const needsPeriod = ready?.notices.includes("adjustment_period") ?? false;
  const periodMissing = needsPeriod && !value.acknowledgments.includes("adjustment_period");
  const typedRent = parseMoney(value.indexedRent);
  const newRent = typedRent !== null && typedRent > 0 ? `R$ ${formatMoneyInput(typedRent)}` : ready ? formatMoney(ready.suggestedRent) : null;

  function change(patch: Partial<AmendmentInput>) {
    setFailure(null);
    setValue((current) => ({ ...current, ...patch }));
  }

  async function onSave() {
    setAttempted(true);
    if (validateAmendment(value, contract).length > 0 || ready === null || periodMissing) return;
    setPending(true);
    setFailure(null);
    const result = await createAmendment({
      data: request({ ...value, acknowledgments: needsPeriod ? value.acknowledgments : [] }),
    });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setOpen(false);
    await router.invalidate();
  }

  const rentLine =
    ready === null || newRent === null
      ? null
      : ready.affectedRents === 0
        ? `Nenhum aluguel em aberto muda. O contrato passa a ter aluguel de ${newRent}.`
        : `${ready.affectedRents === 1 ? "1 aluguel em aberto passa" : `${ready.affectedRents} aluguéis em aberto passam`} para ${newRent}, a partir do vencimento de ${formatDate(ready.firstDueOn ?? "")}.`;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        className="ml-auto"
        onClick={() => {
          setValue(EMPTY);
          setAttempted(false);
          setFailure(null);
          setPreview(null);
          setMounted(true);
          setOpen(true);
        }}
      >
        <IconTrendingUp data-icon="inline-start" aria-hidden="true" />
        Registrar reajuste
      </Button>

      {mounted && (
        <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <DialogContent showCloseButton={false} className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Registrar reajuste</DialogTitle>
              <DialogDescription>
                O novo aluguel vale para os meses que começam na data informada ou depois. Um mês já em andamento mantém o
                valor.
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
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  name="amended_on"
                  label="A partir de"
                  type="date"
                  value={value.amendedOn}
                  error={error("amendedOn")}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    change({ amendedOn: next });
                  }}
                />
                <FormField
                  name="index_rate"
                  label={`Variação ${contract.adjustmentIndex ? `do ${indexLabel(contract.adjustmentIndex)}` : "do índice"} (%)`}
                  placeholder="4,5"
                  inputMode="decimal"
                  autoComplete="off"
                  hint="Acumulada no período. Use o sinal de menos se for negativa."
                  value={value.indexRate}
                  error={error("indexRate")}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    change({ indexRate: next });
                  }}
                />
              </div>

              {preview !== null && !preview.ok && failure === null && (
                <p role="alert" className="text-small text-destructive-soft">
                  {preview.failure.kind === "validation"
                    ? (preview.failure.fields[0]?.message ?? "Confira os valores.")
                    : summaryOf(preview.failure)}
                </p>
              )}

              {ready !== null && (
                <div aria-live="polite" className="flex flex-col gap-1 rounded-md border border-border px-3 py-2.5 text-small">
                  <span>
                    Aluguel atual {formatMoney(ready.previousRent)}. Sugerido {formatMoney(ready.suggestedRent)}.
                  </span>
                  {(parseSignedPercent(value.indexRate) ?? 0) < 0 && (
                    <span className="text-muted-foreground">Uma variação negativa não reduz o aluguel sugerido.</span>
                  )}
                </div>
              )}

              <FormField
                name="indexed_rent"
                label="Novo aluguel (R$)"
                placeholder={ready ? formatMoney(ready.suggestedRent).replace("R$ ", "") : "1.567,50"}
                inputMode="decimal"
                autoComplete="off"
                hint="Vazio para usar o sugerido. Preencha se o valor foi negociado."
                value={value.indexedRent}
                error={error("indexedRent")}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  change({ indexedRent: next });
                }}
              />

              {rentLine !== null && <p className="font-reading text-small text-muted-foreground">{rentLine}</p>}

              {needsPeriod && (
                <div
                  className={cn(
                    "flex flex-col gap-2 rounded-md border px-4 py-3",
                    attempted && periodMissing ? "border-destructive/50 bg-destructive/5" : "border-docs/35 bg-docs/5",
                  )}
                >
                  <p className="text-small font-semibold text-docs-soft">{NOTICES.adjustment_period.title}</p>
                  <p className="font-reading text-small text-muted-foreground">{NOTICES.adjustment_period.text}</p>
                  <div className="flex items-start gap-2.5">
                    <Checkbox
                      id="notice-adjustment_period"
                      checked={!periodMissing}
                      aria-invalid={attempted && periodMissing}
                      onCheckedChange={(checked) =>
                        change({ acknowledgments: checked === true ? ["adjustment_period"] : [] })
                      }
                    />
                    <Label htmlFor="notice-adjustment_period" className="text-small font-normal">
                      Estou ciente
                    </Label>
                  </div>
                  {attempted && periodMissing && (
                    <p className="text-xs text-destructive">Confirme a ciência deste aviso.</p>
                  )}
                </div>
              )}

              {failure !== null && failure.kind !== "validation" && (
                <p role="alert" className="text-small text-destructive-soft">
                  {summaryOf(failure, {
                    stale: "O contrato mudou enquanto você registrava. Feche, confira e registre de novo.",
                  })}
                </p>
              )}

              <DialogFooter className="-mx-4 -mb-4 mt-2">
                <Button type="button" variant="secondary" disabled={pending} onClick={() => setOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={pending || ready === null}>
                  {pending ? "Registrando..." : "Registrar reajuste"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function UndoAmendment({ contract, amendmentId }: { readonly contract: Contract; readonly amendmentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onConfirm() {
    setPending(true);
    setFailure(null);
    const result = await undoAmendment({ data: { id: contract.id, amendmentId, version: contract.version } });
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
        variant="ghost"
        size="sm"
        onClick={() => {
          setFailure(null);
          setMounted(true);
          setOpen(true);
        }}
      >
        <IconArrowBackUp data-icon="inline-start" aria-hidden="true" />
        Desfazer
      </Button>
      {mounted && (
        <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Desfazer o último reajuste?</AlertDialogTitle>
              <AlertDialogDescription>
                O contrato e os aluguéis em aberto que ele alcançou voltam ao valor anterior. O registro de que o reajuste
                foi feito e desfeito fica na auditoria.
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
                {pending ? "Desfazendo..." : "Desfazer"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
