import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import { PropertyForm } from "@/components/properties/property-form";
import { emptyProperty } from "@/domain/property";
import { createProperty } from "@/server/properties";

export const Route = createFileRoute("/_app/imoveis/novo")({
  head: () => ({ meta: [{ title: "Novo imóvel | Imobiliary" }] }),
  component: NewPropertyPage,
});

function NewPropertyPage() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <Link to="/imoveis" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Imóveis
        </Link>
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Novo imóvel</h1>
        <p className="max-w-xl font-reading text-muted-foreground">
          O endereço e ao menos um proprietário são obrigatórios. Os proprietários precisam estar
          cadastrados em Pessoas.
        </p>
      </header>

      <PropertyForm
        initial={emptyProperty()}
        owners={[]}
        submitLabel="Cadastrar"
        save={(value) => createProperty({ data: value })}
        onSaved={async (property) => {
          await navigate({ to: "/imoveis/$propertyId", params: { propertyId: property.id } });
        }}
      />
    </div>
  );
}
