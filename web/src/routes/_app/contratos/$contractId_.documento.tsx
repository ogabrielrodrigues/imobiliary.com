import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { Review, TemplateChoice } from "@/components/documents/document-composer";
import { ROLE_LABELS } from "@/domain/contract";
import { getContract } from "@/server/contracts";
import { listTemplates } from "@/server/documents";

export const Route = createFileRoute("/_app/contratos/$contractId_/documento")({
  loader: async ({ params }) => ({
    contract: await getContract({ data: params.contractId }),
    templates: await listTemplates(),
  }),
  head: () => ({ meta: [{ title: "Gerar documento | Imobiliary" }] }),
  component: GenerateDocumentPage,
});

/**
 * Generating a document from this contract, in two steps.
 *
 * First the template, then the review: the contract answers most of what a
 * lease template asks, and the review is where the office reads the document
 * with those answers in place and changes anything it wants before the file is
 * written. A field the contract cannot answer is shown empty, marked, and
 * filled here.
 */
function GenerateDocumentPage() {
  const { contractId } = Route.useParams();
  const { contract, templates } = Route.useLoaderData();
  const [templateId, setTemplateId] = useState<string | null>(null);
  const navigate = useNavigate();

  const back = (
    <Link
      to="/contratos/$contractId"
      params={{ contractId }}
      className="flex items-center gap-1 self-start text-small text-muted-foreground hover:text-foreground"
    >
      <IconArrowLeft aria-hidden="true" className="size-4" />
      Voltar ao contrato
    </Link>
  );

  if (!contract.ok) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {summaryOf(contract.failure, {
            not_found: "Este contrato não existe ou foi excluído.",
          })}
        </p>
      </div>
    );
  }

  if (!templates.ok) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 md:p-8">
        {back}
        <p role="alert" className="text-destructive-soft">
          {summaryOf(templates.failure, {
            authentication:
              "Não foi possível falar com o serviço de documentos. Entre novamente.",
          })}
        </p>
      </div>
    );
  }

  const tenant =
    contract.value.parties.find((party) => party.role === "tenant")?.name ?? "";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 md:p-8">
      <header className="flex flex-col gap-2">
        {back}
        <h1 className="text-title-lg font-semibold tracking-[-0.015em]">
          Gerar documento
        </h1>
        <p className="text-small text-muted-foreground">
          Contrato {contract.value.registry}
          {tenant === "" ? "" : `, ${ROLE_LABELS.tenant.toLowerCase()} ${tenant}`}
        </p>
      </header>

      {templateId === null ? (
        <TemplateChoice templates={templates.value} onChoose={setTemplateId} />
      ) : (
        <Review
          subject={{ kind: "contract", id: contractId }}
          templateId={templateId}
          record={contract.value.registry}
          person={tenant}
          noun="o contrato"
          onBack={() => setTemplateId(null)}
          onGenerated={() => navigate({ to: "/contratos/$contractId", params: { contractId } })}
        />
      )}
    </div>
  );
}
