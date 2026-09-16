import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import { ContractForm } from "@/components/contracts/contract-form";
import { emptyContract } from "@/domain/contract";
import { createContract } from "@/server/contracts";

export const Route = createFileRoute("/_app/contratos/novo")({
  head: () => ({ meta: [{ title: "Novo contrato | Imobiliary" }] }),
  component: NewContractPage,
});

function NewContractPage() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <Link to="/contratos" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Contratos
        </Link>
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Novo contrato</h1>
        <p className="max-w-xl font-reading text-muted-foreground">
          O imóvel e as partes precisam estar cadastrados antes. Na revisão você confere os aluguéis de todo o prazo.
        </p>
      </header>

      <ContractForm
        initial={emptyContract()}
        initialProperty={null}
        initialPeople={[]}
        submitLabel="Registrar contrato"
        save={(value) => createContract({ data: value })}
        onSaved={async (contract) => {
          await navigate({ to: "/contratos/$contractId", params: { contractId: contract.id } });
        }}
      />
    </div>
  );
}
