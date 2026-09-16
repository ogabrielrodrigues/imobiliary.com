import { useState } from "react";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";

import { summaryOf, type Failure } from "@/application/result";
import { PropertyForm } from "@/components/properties/property-form";
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
import { addressLine, addressPlace } from "@/domain/property";
import { deleteProperty, getProperty, updateProperty } from "@/server/properties";

export const Route = createFileRoute("/_app/imoveis/$propertyId")({
  loader: ({ params }) => getProperty({ data: params.propertyId }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.ok ? addressLine(loaderData.value.address) : "Imóvel"} | Imobiliary` }],
  }),
  component: PropertyPage,
});

/** One property: the form to edit it, keyed on the version, and deleting it. */
function PropertyPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [saved, setSaved] = useState(false);

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-8">
        <Link to="/imoveis" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Imóveis
        </Link>
        <p role="alert" className="text-destructive-soft">
          {summaryOf(result.failure, { not_found: "Este imóvel não existe ou foi excluído." })}
        </p>
      </div>
    );
  }

  const property = result.value;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <Link to="/imoveis" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Imóveis
        </Link>
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-title-lg font-semibold tracking-[-0.015em] break-words">{addressLine(property.address)}</h1>
            <span className="text-small text-muted-foreground">{addressPlace(property.address)}</span>
            <Link
              to="/contratos"
              search={{ imovel: property.id }}
              className="self-start text-small text-muted-foreground underline hover:text-foreground"
            >
              Ver contratos deste imóvel
            </Link>
          </div>
          <DeleteProperty id={property.id} label={addressLine(property.address)} />
        </div>
      </header>

      {saved && (
        <p role="status" className="rounded-md border border-success/35 bg-success/5 px-4 py-3 text-small text-success-soft">
          Alterações salvas.
        </p>
      )}

      <PropertyForm
        key={property.version}
        initial={{ ...property, owners: property.owners.map((o) => ({ personId: o.personId, share: o.share })) }}
        owners={property.owners.map((o) => ({ id: o.personId, kind: o.kind, name: o.name, tradeName: "" }))}
        submitLabel="Salvar alterações"
        save={(value) => {
          setSaved(false);
          return updateProperty({ data: { id: property.id, version: property.version, property: value } });
        }}
        onSaved={async () => {
          await router.invalidate();
          setSaved(true);
        }}
      />
    </div>
  );
}

function DeleteProperty({ id, label }: { readonly id: string; readonly label: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Mounted only once asked for: a Base UI dialog cannot render on the server.
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  async function onConfirm() {
    setPending(true);
    setFailure(null);
    const result = await deleteProperty({ data: id });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    await navigate({ to: "/imoveis" });
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
              <AlertDialogTitle>Excluir {label}?</AlertDialogTitle>
              <AlertDialogDescription>
                O imóvel, o endereço e as partes dos proprietários são apagados de vez. Os cadastros
                dos proprietários continuam em Pessoas.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {failure !== null && (
              <p role="alert" className="text-small text-destructive-soft">
                {summaryOf(failure, {
                  in_use: "Não é possível excluir: este imóvel ainda está ligado a um contrato.",
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
