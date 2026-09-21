import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconArrowBackUp, IconArrowLeft, IconPrinter } from "@tabler/icons-react";

import { summaryOf, type Failure } from "@/application/result";
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
import { Statement } from "@/components/payouts/statement";
import { methodLabel, totalsByKind, type PayoutDetail } from "@/domain/payout";
import { payoutStatement, undoPayout } from "@/server/payouts";

export const Route = createFileRoute("/_app/repasses/$payoutId")({
  loader: ({ params }) => payoutStatement({ data: params.payoutId }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.ok ? `Repasse ${loaderData.value.payout.number}` : "Repasse"} | Imobiliary` }],
  }),
  component: PayoutPage,
});

function PayoutPage() {
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
          {summaryOf(result.failure, { not_found: "Este repasse não existe ou foi desfeito." })}
        </p>
      </div>
    );
  }

  const { payout, administrator } = result.value;
  const totals = totalsByKind(payout.entries);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        {back}
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Repasse Nº {payout.number}</h1>
            <Link
              to="/repasses/pessoa/$personId"
              params={{ personId: payout.person.id }}
              className="text-small text-muted-foreground hover:text-foreground hover:underline"
            >
              {payout.person.name}
            </Link>
            <span className="text-small text-muted-foreground">
              Transferido em {formatDate(payout.paidOn)}
              {payout.method !== "" && ` por ${methodLabel(payout.method)}`}
              {payout.note !== "" && ` · ${payout.note}`}
            </span>
          </div>
          <div className="ml-auto flex flex-col items-end">
            <span className="text-caption text-muted-foreground">Total repassado</span>
            <span className="text-title font-semibold tabular-nums">{formatMoney(payout.total)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            nativeButton={false}
            render={<Link to="/repasses/$payoutId/recibo" params={{ payoutId: payout.id }} search={{ tipo: "repasse" }} />}
          >
            <IconPrinter data-icon="inline-start" aria-hidden="true" />
            Recibo de repasse
          </Button>
          {totals.admin_fee > 0 && (
            <Button
              variant="secondary"
              nativeButton={false}
              render={<Link to="/repasses/$payoutId/recibo" params={{ payoutId: payout.id }} search={{ tipo: "taxa" }} />}
            >
              <IconPrinter data-icon="inline-start" aria-hidden="true" />
              Recibo da taxa
            </Button>
          )}
          <Undo payout={payout} />
        </div>
        {administrator === null && (
          <p className="rounded-md border border-docs/35 bg-docs/5 px-3 py-2 text-small text-docs-soft">
            Os recibos saem só com o nome do escritório enquanto o administrador não for informado em{" "}
            <Link to="/ajustes" search={{ aba: "escritorio" }} className="underline">
              Ajustes, Escritório
            </Link>
            .
          </p>
        )}
      </header>

      <Statement payout={payout} />
    </div>
  );
}

function Undo({ payout }: { readonly payout: PayoutDetail }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onConfirm() {
    setPending(true);
    setFailure(null);
    const result = await undoPayout({ data: payout.id });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setOpen(false);
    await navigate({ to: "/repasses/pessoa/$personId", params: { personId: payout.person.id } });
  }

  return (
    <>
      <Button
        variant="ghost"
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
              <AlertDialogTitle>Desfazer o repasse {payout.number}?</AlertDialogTitle>
              <AlertDialogDescription>
                Os lançamentos voltam para o saldo de {payout.person.name}. Use quando o repasse foi registrado por engano
                ou o dinheiro voltou. A plataforma não desfaz a transferência no banco.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {failure !== null && (
              <p role="alert" className="text-small text-destructive-soft">
                {summaryOf(failure)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction disabled={pending} onClick={() => void onConfirm()}>
                {pending ? "Desfazendo..." : "Desfazer repasse"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
