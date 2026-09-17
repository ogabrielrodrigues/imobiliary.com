import { useState, type ReactNode } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { IconArrowLeft, IconBan, IconPencil, IconTrash } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { ContractAmendments } from "@/components/contracts/amendments";
import { ContractStatusBadge } from "@/components/contracts/status-badge";
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
import {
  formatDate,
  formatMoney,
  guaranteeLabel,
  indexLabel,
  NOTICES,
  percentFromApi,
  RENT_STATUS_LABELS,
  ROLE_LABELS,
  validateTermination,
  type Contract,
} from "@/domain/contract";
import { addressLine, addressPlace } from "@/domain/property";
import { cn } from "@/lib/utils";
import { deleteContract, getContract, terminateContract } from "@/server/contracts";

export const Route = createFileRoute("/_app/contratos/$contractId")({
  loader: ({ params }) => getContract({ data: params.contractId }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.ok ? `Contrato ${loaderData.value.registry}` : "Contrato"} | Imobiliary` }],
  }),
  component: ContractPage,
});

/** One contract: its terms, parties, acknowledged notices and rents. */
function ContractPage() {
  const result = Route.useLoaderData();

  const back = (
    <Link to="/contratos" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
      <IconArrowLeft aria-hidden="true" className="size-4" />
      Contratos
    </Link>
  );

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {summaryOf(result.failure, { not_found: "Este contrato não existe ou foi excluído." })}
        </p>
      </div>
    );
  }

  const contract = result.value;
  const paid = contract.rents.some((r) => r.status === "paid");
  const terminated = contract.terminatedOn !== null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-title-lg font-semibold tracking-[-0.015em] break-words">Contrato {contract.registry}</h1>
              <ContractStatusBadge status={contract.status} />
            </div>
            <Link
              to="/imoveis/$propertyId"
              params={{ propertyId: contract.propertyId }}
              className="text-small text-muted-foreground hover:text-foreground hover:underline"
            >
              {addressLine(contract.address)}, {addressPlace(contract.address)}
            </Link>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {!terminated && !paid && contract.amendments.length === 0 && (
              <Button
                variant="secondary"
                size="sm"
                nativeButton={false}
                render={<Link to="/contratos/$contractId/editar" params={{ contractId: contract.id }} />}
              >
                <IconPencil data-icon="inline-start" aria-hidden="true" />
                Editar
              </Button>
            )}
            {!terminated && <TerminateContract contract={contract} />}
            {!paid && <DeleteContract id={contract.id} registry={contract.registry} />}
          </div>
        </div>
      </header>

      <Section title="Termos">
        <dl className="grid gap-x-6 gap-y-2 text-small md:grid-cols-[auto_1fr]">
          <Term label="Aluguel">
            {formatMoney(contract.currentRent)}
            {contract.currentRent !== contract.rent && (
              <span className="text-muted-foreground"> (inicial {formatMoney(contract.rent)})</span>
            )}
          </Term>
          <Term label="Prazo">
            {formatDate(contract.startsOn)} a {formatDate(contract.expiresOn)}
          </Term>
          {contract.terminatedOn !== null && <Term label="Rescisão">{formatDate(contract.terminatedOn)}</Term>}
          <Term label="Assinatura">{formatDate(contract.signedOn)}</Term>
          <Term label="Vencimento">
            Dia {contract.dueDay}, {contract.advanceRent ? "com o primeiro no início" : "depois de cada mês vencido"}
          </Term>
          <Term label="Aluguel antecipado">{contract.advanceRent ? "Sim" : "Não"}</Term>
          <Term label="Reajuste">{indexLabel(contract.adjustmentIndex)}</Term>
          <Term label="Garantia">
            {guaranteeLabel(contract.guaranteeKind)}
            {contract.guaranteeKind === "deposit" && ` de ${formatMoney(contract.depositAmount)}`}
          </Term>
          <Term label="Administração">{percentFromApi(contract.adminFee)}%</Term>
          <Term label="Multa e juros">
            {percentFromApi(contract.latePenaltyRate)}% de multa e {percentFromApi(contract.lateInterestRate)}% de juros ao
            mês
          </Term>
        </dl>
      </Section>

      <Section title="Partes">
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {contract.parties.map((party) => (
            <li key={`${party.personId}-${party.role}`} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Link
                to="/pessoas/$personId"
                params={{ personId: party.personId }}
                className="min-w-0 flex-1 truncate text-small font-medium hover:underline"
              >
                {party.name}
              </Link>
              <span className="font-mono text-micro tracking-[0.1em] text-faint uppercase">{ROLE_LABELS[party.role]}</span>
            </li>
          ))}
        </ul>
      </Section>

      {contract.acknowledgments.length > 0 && (
        <Section title="Avisos legais com ciência">
          <ul className="flex flex-col gap-2">
            {contract.acknowledgments.map((ack) => (
              <li key={ack.code} className="flex flex-col gap-0.5 text-small">
                <span className="font-medium">{NOTICES[ack.code].title}</span>
                <span className="text-caption text-muted-foreground">
                  Ciência registrada em {new Date(ack.acknowledgedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <ContractAmendments contract={contract} />

      <Section title={`Aluguéis (${contract.rents.length})`}>
        {contract.rents.length === 0 ? (
          <p className="text-small text-muted-foreground">Nenhum aluguel neste contrato.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-small tabular-nums">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-4 font-medium">Parcela</th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">Vencimento</th>
                  <th scope="col" className="py-1.5 pr-4 text-right font-medium">Valor</th>
                  <th scope="col" className="py-1.5 font-medium">Situação</th>
                </tr>
              </thead>
              <tbody className="font-reading">
                {contract.rents.map((rent) => (
                  <tr key={rent.id} className="border-t border-border">
                    <td className="py-1.5 pr-4">
                      <Link to="/alugueis/$rentId" params={{ rentId: rent.id }} className="underline hover:text-foreground">
                        {rent.sequence}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4">{formatDate(rent.dueOn)}</td>
                    <td className="py-1.5 pr-4 text-right">
                      {formatMoney(rent.amount)}
                      {rent.chargesTotal !== "0.00" && (
                        <span className="block text-caption text-muted-foreground">
                          mais {formatMoney(rent.chargesTotal)} em cobranças
                        </span>
                      )}
                      {contract.terminatedOn !== null &&
                        rent.sequence === contract.rents.length &&
                        rent.amount !== contract.currentRent && (
                          <span className="block text-caption text-muted-foreground">proporcional</span>
                        )}
                    </td>
                    <td
                      className={cn(
                        "py-1.5",
                        rent.status === "paid" && "text-success-soft",
                        rent.status === "overdue" && "text-destructive-soft",
                        rent.status === "pending" && "text-muted-foreground",
                      )}
                    >
                      {RENT_STATUS_LABELS[rent.status]}
                      {rent.paidOn !== null && ` em ${formatDate(rent.paidOn)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function Term({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
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

function TerminateContract({ contract }: { readonly contract: Contract }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Mounted only once asked for: a Base UI dialog cannot render on the server.
  const [mounted, setMounted] = useState(false);
  const [on, setOn] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const localError = attempted ? (validateTermination(contract, on) ?? undefined) : undefined;
  const error = messageFor(failure, "terminated_on") ?? localError;

  async function onConfirm() {
    setAttempted(true);
    if (validateTermination(contract, on) !== null) return;
    setPending(true);
    setFailure(null);
    const result = await terminateContract({
      data: { id: contract.id, version: contract.version, startsOn: contract.startsOn, expiresOn: contract.expiresOn, terminatedOn: on },
    });
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
        size="sm"
        onClick={() => {
          setFailure(null);
          setAttempted(false);
          setMounted(true);
          setOpen(true);
        }}
      >
        <IconBan data-icon="inline-start" aria-hidden="true" />
        Rescindir
      </Button>

      {mounted && (
        <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Rescindir o contrato {contract.registry}?</AlertDialogTitle>
              <AlertDialogDescription>
                O contrato termina na data informada e o imóvel fica livre a partir do dia seguinte. Os aluguéis dos meses
                seguintes são removidos, e o mês da rescisão é cobrado proporcionalmente aos dias de locação. A rescisão
                não pode ser desfeita.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <FormField
              name="terminated_on"
              label="Data da rescisão"
              type="date"
              min={contract.startsOn}
              max={contract.expiresOn}
              value={on}
              error={error}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setFailure(null);
                setOn(next);
              }}
            />
            {failure !== null && failure.kind !== "validation" && (
              <p role="alert" className="text-small text-destructive-soft">
                {summaryOf(failure)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
                {pending ? "Rescindindo..." : "Rescindir"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

function DeleteContract({ id, registry }: { readonly id: string; readonly registry: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onConfirm() {
    setPending(true);
    setFailure(null);
    const result = await deleteContract({ data: id });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await navigate({ to: "/contratos" });
  }

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          setFailure(null);
          setMounted(true);
          setOpen(true);
        }}
      >
        <IconTrash data-icon="inline-start" aria-hidden="true" />
        Excluir
      </Button>

      {mounted && (
        <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Excluir o contrato {registry}?</AlertDialogTitle>
              <AlertDialogDescription>
                O contrato, as partes, as ciências dos avisos e os aluguéis são apagados de vez. O imóvel e as pessoas
                continuam cadastrados.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {failure !== null && (
              <p role="alert" className="text-small text-destructive-soft">
                {summaryOf(failure, {
                  in_use: "Não é possível excluir: este contrato já tem aluguel pago. Rescinda o contrato.",
                })}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
                {pending ? "Excluindo..." : "Excluir"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
