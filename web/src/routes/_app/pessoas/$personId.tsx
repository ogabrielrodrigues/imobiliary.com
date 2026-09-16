import { useState } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";

import { summaryOf, type Failure } from "@/application/result";
import { PersonForm } from "@/components/people/person-form";
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
import { KIND_LABELS } from "@/domain/person";
import { deletePerson, getPerson, updatePerson } from "@/server/people";

export const Route = createFileRoute("/_app/pessoas/$personId")({
  loader: ({ params }) => getPerson({ data: params.personId }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.ok ? loaderData.value.person.name : "Pessoa"} | Imobiliary` }],
  }),
  component: PersonPage,
});

/**
 * One person: the form to edit them, and deleting them.
 *
 * The form is keyed on the version. After a save the loader runs again and the
 * form starts from what the API now holds, which is also the version the next
 * edit must send.
 */
function PersonPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [saved, setSaved] = useState(false);

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-8">
        <Link to="/pessoas" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Pessoas
        </Link>
        <p role="alert" className="text-destructive-soft">
          {summaryOf(result.failure, { not_found: "Esta pessoa não existe ou foi excluída." })}
        </p>
      </div>
    );
  }

  const { person, linked } = result.value;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <Link to="/pessoas" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Pessoas
        </Link>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-title-lg font-semibold tracking-[-0.015em] break-words">{person.name}</h1>
            <span className="font-mono text-micro tracking-[0.1em] text-faint uppercase">
              {KIND_LABELS[person.kind]}
            </span>
          </div>
          <DeletePerson id={person.id} name={person.name} />
        </div>
      </header>

      {saved && (
        <p role="status" className="rounded-md border border-success/35 bg-success/5 px-4 py-3 text-small text-success-soft">
          Alterações salvas.
        </p>
      )}

      <PersonForm
        key={person.version}
        initial={person}
        personId={person.id}
        linked={linked}
        kindLocked
        submitLabel="Salvar alterações"
        save={(value) => {
          setSaved(false);
          return updatePerson({ data: { id: person.id, version: person.version, person: value } });
        }}
        onSaved={async () => {
          await router.invalidate();
          setSaved(true);
        }}
      />
    </div>
  );
}

function DeletePerson({ id, name }: { readonly id: string; readonly name: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Mounted only once asked for: a Base UI dialog cannot render on the server.
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onConfirm() {
    setPending(true);
    setFailure(null);
    const result = await deletePerson({ data: id });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await navigate({ to: "/pessoas" });
  }

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        className="ml-auto"
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
              <AlertDialogTitle>Excluir {name}?</AlertDialogTitle>
              <AlertDialogDescription>
                O cadastro e os endereços são apagados de vez. Se houver cônjuge ligado, o outro
                cadastro continua, sem o vínculo.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {failure !== null && (
              <p role="alert" className="text-small text-destructive-soft">
                {summaryOf(failure, {
                  in_use:
                    "Não é possível excluir: esta pessoa ainda está ligada a outro cadastro, como uma empresa que representa. Desfaça o vínculo antes.",
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
