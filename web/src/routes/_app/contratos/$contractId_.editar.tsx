import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { ContractForm } from "@/components/contracts/contract-form";
import { contractToInput } from "@/domain/contract";
import { getContract, updateContract } from "@/server/contracts";

// The trailing underscore keeps this page out of the contract page, which has
// no Outlet.
export const Route = createFileRoute("/_app/contratos/$contractId_/editar")({
  loader: ({ params }) => getContract({ data: params.contractId }),
  head: ({ loaderData }) => ({
    meta: [{ title: `Editar ${loaderData?.ok ? `contrato ${loaderData.value.registry}` : "contrato"} | Imobiliary` }],
  }),
  component: EditContractPage,
});

function EditContractPage() {
  const result = Route.useLoaderData();
  const navigate = useNavigate();

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-8">
        <Link to="/contratos" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Contratos
        </Link>
        <p role="alert" className="text-destructive-soft">
          {summaryOf(result.failure, { not_found: "Este contrato não existe ou foi excluído." })}
        </p>
      </div>
    );
  }

  const contract = result.value;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <Link
          to="/contratos/$contractId"
          params={{ contractId: contract.id }}
          className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground"
        >
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Contrato {contract.registry}
        </Link>
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Editar contrato {contract.registry}</h1>
        <p className="max-w-xl font-reading text-muted-foreground">
          Ao salvar, os aluguéis são gerados de novo com os valores e as datas desta edição.
        </p>
      </header>

      <ContractForm
        key={contract.version}
        initial={contractToInput(contract)}
        initialProperty={{ id: contract.propertyId, address: contract.address, registry: "", ownerNames: [] }}
        initialPeople={contract.parties.map((p) => ({ id: p.personId, kind: p.kind, name: p.name, tradeName: "" }))}
        submitLabel="Salvar alterações"
        save={(value) => updateContract({ data: { id: contract.id, version: contract.version, contract: value } })}
        onSaved={async (saved) => {
          await navigate({ to: "/contratos/$contractId", params: { contractId: saved.id } });
        }}
      />
    </div>
  );
}
