import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { Review, TemplateChoice } from "@/components/documents/document-composer";
import { listTemplates } from "@/server/documents";
import { payoutStatement } from "@/server/payouts";

export const Route = createFileRoute("/_app/repasses/$payoutId_/documento")({
  loader: async ({ params }) => ({
    statement: await payoutStatement({ data: params.payoutId }),
    templates: await listTemplates(),
  }),
  head: () => ({ meta: [{ title: "Gerar documento | Imobiliary" }] }),
  component: GeneratePayoutDocumentPage,
});

/**
 * A payout statement from a template of the office's own: the payout, the
 * owner field by field, the totals and each property (docs/campos.md,
 * section 9), reviewed before the file is written.
 */
function GeneratePayoutDocumentPage() {
  const { payoutId } = Route.useParams();
  const { statement, templates } = Route.useLoaderData();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const navigate = useNavigate();

  const back = (
    <Link
      to="/repasses/$payoutId"
      params={{ payoutId }}
      className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground"
    >
      <IconArrowLeft aria-hidden="true" className="size-4" />
      Voltar ao repasse
    </Link>
  );

  if (!statement.ok || !templates.ok) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {!statement.ok
            ? summaryOf(statement.failure, { not_found: "Este repasse não existe ou foi desfeito." })
            : summaryOf(templates.ok ? null : templates.failure, {
                authentication: "Não foi possível falar com o serviço de documentos. Entre novamente.",
              })}
        </p>
      </div>
    );
  }

  const { payout } = statement.value;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        {back}
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">Gerar documento</h1>
        <p className="text-small text-muted-foreground">
          Repasse {payout.number}, {payout.person.name}
        </p>
      </header>

      {templateId === null ? (
        <TemplateChoice templates={templates.value} onChoose={setTemplateId} />
      ) : (
        <Review
          subject={{ kind: "payout", id: payoutId }}
          templateId={templateId}
          record={payout.number}
          person={payout.person.name}
          noun="o repasse"
          onBack={() => setTemplateId(null)}
          onGenerated={() => navigate({ to: "/repasses/$payoutId", params: { payoutId } })}
        />
      )}
    </div>
  );
}
