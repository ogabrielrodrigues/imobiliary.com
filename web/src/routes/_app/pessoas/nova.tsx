import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import { PersonForm } from "@/components/people/person-form";
import { emptyPerson } from "@/domain/person";
import { createPerson } from "@/server/people";

export const Route = createFileRoute("/_app/pessoas/nova")({
  head: () => ({ meta: [{ title: "Nova pessoa | Imobiliary" }] }),
  component: NewPersonPage,
});

function NewPersonPage() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <Link to="/pessoas" className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground">
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Pessoas
        </Link>
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Nova pessoa</h1>
        <p className="max-w-xl font-reading text-muted-foreground">
          Para pessoa física, nome e CPF são obrigatórios. Estado civil e endereço entram no
          contrato, então vale completar antes de usá-lo em um.
        </p>
      </header>

      <PersonForm
        initial={emptyPerson()}
        linked={[]}
        kindLocked={false}
        submitLabel="Cadastrar"
        save={(value) => createPerson({ data: value })}
        onSaved={async (person) => {
          await navigate({ to: "/pessoas/$personId", params: { personId: person.id } });
        }}
      />
    </div>
  );
}
