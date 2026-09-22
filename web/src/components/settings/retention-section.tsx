import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";

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
import type { AnonymizationCandidate } from "@/domain/anonymization";
import { formatDate } from "@/domain/contract";
import { anonymizePerson } from "@/server/people";

/**
 * Anonymisation at the end of the legal retention. The platform lists who
 * is past it; an administrator confirms each person. Members see the list,
 * since they may be the ones who know a record is still needed.
 */
export function RetentionSection({
  candidates,
  isAdmin,
}: {
  readonly candidates: readonly AnonymizationCandidate[];
  readonly isAdmin: boolean;
}) {
  const [done, setDone] = useState<string | null>(null);

  return (
    <section aria-labelledby="retention-title" className="flex max-w-2xl flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4">
      <h2 id="retention-title" className="text-sm font-semibold">
        Guarda de dados
      </h2>
      <p className="text-small text-muted-foreground">
        O escritório guarda os dados de quem já não tem contrato por cinco anos, contados do ano seguinte ao último
        registro, pelo prazo fiscal. Passado esse prazo, a pessoa aparece aqui para ser anonimizada: o cadastro fica, com
        contratos, aluguéis e repasses, mas sem nome, documento, contatos e endereços.
      </p>
      {done !== null && (
        <p role="status" className="rounded-md border border-success/35 bg-success/5 px-3 py-2 text-small text-success-soft">
          {done}
        </p>
      )}
      {candidates.length === 0 ? (
        <p className="text-small text-muted-foreground">Ninguém passou do prazo de guarda.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {candidates.map((c) => (
            <li key={c.person.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="flex min-w-0 grow flex-col gap-0.5">
                <Link
                  to="/pessoas/$personId"
                  params={{ personId: c.person.id }}
                  className="truncate text-small font-medium hover:underline"
                >
                  {c.person.name}
                </Link>
                <span className="text-caption text-muted-foreground">
                  Último registro em {formatDate(c.lastActivityOn)}; o prazo terminou em {formatDate(c.retentionEndedOn)}.
                </span>
              </div>
              {isAdmin && <Anonymize candidate={c} onDone={setDone} />}
            </li>
          ))}
        </ul>
      )}
      {!isAdmin && candidates.length > 0 && (
        <p className="text-caption text-muted-foreground">Um administrador do escritório confirma cada anonimização.</p>
      )}
    </section>
  );
}

function Anonymize({
  candidate,
  onDone,
}: {
  readonly candidate: AnonymizationCandidate;
  readonly onDone: (message: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const going = candidate.contracts.filter((c) => c.documentsCanGo);
  const staying = candidate.contracts.filter((c) => !c.documentsCanGo);

  async function onConfirm() {
    setPending(true);
    setFailure(null);
    const result = await anonymizePerson({ data: candidate.person.id });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    const { documentsDeleted: deleted, documentsKept: kept } = result.value;
    setOpen(false);
    onDone(
      `O cadastro de ${candidate.person.name} foi anonimizado.` +
        (deleted > 0 ? ` ${deleted} ${deleted === 1 ? "documento excluído" : "documentos excluídos"} do Docs.` : "") +
        (kept > 0 ? ` ${kept} ${kept === 1 ? "documento ficou" : "documentos ficaram"}, porque ${kept === 1 ? "nomeia" : "nomeiam"} outras partes ainda cadastradas.` : ""),
    );
    await router.invalidate();
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setFailure(null);
          setMounted(true);
          setOpen(true);
        }}
      >
        Anonimizar
      </Button>
      {mounted && (
        <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Anonimizar {candidate.person.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                O nome passa a ser "Pessoa anonimizada", e documento, contatos, endereços e dados pessoais são apagados.
                Contratos, aluguéis e repasses continuam, sem nome. Não dá para desfazer.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-small text-muted-foreground">
              {going.length > 0 && (
                <li>
                  Documentos gerados {going.length === 1 ? "do contrato" : "dos contratos"}{" "}
                  {going.map((c) => c.registry).join(", ")} são excluídos do Docs.
                </li>
              )}
              {candidate.payouts.length > 0 && (
                <li>
                  Documentos gerados {candidate.payouts.length === 1 ? "do repasse" : "dos repasses"}{" "}
                  {candidate.payouts.map((p) => p.number).join(", ")} são excluídos do Docs.
                </li>
              )}
              {staying.length > 0 && (
                <li>
                  Os documentos {staying.length === 1 ? "do contrato" : "dos contratos"}{" "}
                  {staying.map((c) => c.registry).join(", ")} ficam, porque nomeiam outras partes ainda cadastradas.
                </li>
              )}
            </ul>
            {failure !== null && (
              <p role="alert" className="text-small text-destructive-soft">
                {failure.kind === "validation" ? failure.fields[0]?.message : summaryOf(failure)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction variant="destructive" disabled={pending} onClick={onConfirm}>
                {pending ? "Anonimizando..." : "Anonimizar"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
