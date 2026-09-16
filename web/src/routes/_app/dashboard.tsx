import { createFileRoute } from "@tanstack/react-router";
import { IconBuildingEstate, IconFileDescription, IconUsers } from "@tabler/icons-react";

export const Route = createFileRoute("/_app/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard | Imobiliary" }] }),
  component: DashboardPage,
});

/**
 * The dashboard, still without figures.
 *
 * Its cards are settled — receipts of the month, the portfolio, the deadlines
 * and the office's own fee — and every one of them counts contracts and rents
 * that do not exist yet. Rather than draw empty charts, this says what is
 * coming and in which order, so someone signing in today can see whether the
 * product is going where they need it to.
 */
function DashboardPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Dashboard</h1>
        <p className="max-w-xl font-reading text-muted-foreground">
          Aqui ficarão os aluguéis que vencem hoje, o que já foi recebido no mês, os contratos que
          terminam em breve e os reajustes do período.
        </p>
      </header>

      <ol className="flex flex-col gap-3">
        <Step
          icon={IconUsers}
          title="Pessoas"
          description="Proprietários, locatários e fiadores, cadastrados uma vez e reaproveitados em todos os contratos."
        />
        <Step
          icon={IconBuildingEstate}
          title="Imóveis"
          description="Endereço, matrícula, inscrição de IPTU e os proprietários de cada um."
        />
        <Step
          icon={IconFileDescription}
          title="Contratos e aluguéis"
          description="Contrato com garantia e reajuste, parcelas geradas para todo o prazo e o registro dos pagamentos."
        />
      </ol>
    </div>
  );
}

function Step({
  icon: Icon,
  title,
  description,
}: {
  readonly icon: typeof IconUsers;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card p-4">
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary-text" />
      <div className="flex flex-col gap-1">
        <h2 className="text-small font-semibold">{title}</h2>
        <p className="font-reading text-small text-muted-foreground">{description}</p>
      </div>
    </li>
  );
}
