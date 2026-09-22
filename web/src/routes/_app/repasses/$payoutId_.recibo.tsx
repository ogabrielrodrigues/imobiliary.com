import { createFileRoute, Link } from "@tanstack/react-router";
import { IconArrowLeft, IconPrinter } from "@tabler/icons-react";

import { summaryOf } from "@/application/result";
import { Statement } from "@/components/payouts/statement";
import { Button } from "@/components/ui/button";
import { formatMoney, formatMoneyInput } from "@/domain/contract";
import { formatLongDate, groupByProperty, methodLabel, totalsByKind } from "@/domain/payout";
import { addressLine, addressPlace } from "@/domain/property";
import { payoutStatement } from "@/server/payouts";

type ReceiptKind = "repasse" | "taxa";

export const Route = createFileRoute("/_app/repasses/$payoutId_/recibo")({
  validateSearch: (search: Record<string, unknown>): { tipo?: ReceiptKind | undefined } => ({
    tipo: search["tipo"] === "taxa" || search["tipo"] === "repasse" ? search["tipo"] : undefined,
  }),
  loader: ({ params }) => payoutStatement({ data: params.payoutId }),
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData?.ok ? `Recibo ${loaderData.value.payout.number}` : "Recibo"} | Imobiliary` }],
  }),
  component: ReceiptPage,
});

/**
 * A receipt drawn for paper: A4, black on white whatever the theme, and the
 * app's shell hidden when printing. The browser's own print, which also
 * saves as PDF, is what makes it a file.
 *
 * Two receipts from one payout: the payout receipt, which the owner signs for
 * the money received; and the fee receipt, which the administrator signs for
 * the fee kept, the self-employed broker's document since there is no invoice.
 */
function ReceiptPage() {
  const result = Route.useLoaderData();
  const { tipo = "repasse" } = Route.useSearch();
  const { user } = Route.useRouteContext();

  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8">
        <p role="alert" className="text-destructive-soft">
          {summaryOf(result.failure, { not_found: "Este repasse não existe ou foi desfeito." })}
        </p>
      </div>
    );
  }

  const { payout, administrator, beneficiaryDocument } = result.value;
  const office = user.organization.name;
  const officeDocument =
    administrator === null ? "" : `, ${administrator.kind === "company" ? "CNPJ" : "CPF"} ${administrator.document}`;
  const creci = administrator !== null && administrator.creci !== "" ? administrator.creci : "";
  const beneficiary = `${payout.person.name}${beneficiaryDocument === "" ? "" : `, ${payout.person.kind === "company" ? "CNPJ" : "CPF"} ${beneficiaryDocument}`}`;
  const fee = totalsByKind(payout.entries).admin_fee;
  const groups = groupByProperty(payout.entries).filter((g) => g.address !== null);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-8 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Link
          to="/repasses/$payoutId"
          params={{ payoutId: payout.id }}
          className="flex items-center gap-1 text-small text-muted-foreground hover:text-foreground"
        >
          <IconArrowLeft aria-hidden="true" className="size-4" />
          Repasse {payout.number}
        </Link>
        <Button className="ml-auto" onClick={() => window.print()}>
          <IconPrinter data-icon="inline-start" aria-hidden="true" />
          Imprimir
        </Button>
      </div>
      {tipo === "taxa" && administrator?.kind === "company" && (
        <p className="text-small text-muted-foreground print:hidden">
          Para a imobiliária, este recibo não substitui a nota fiscal de serviço da taxa, emitida à parte.
        </p>
      )}

      {/* A light theme on the sheet itself: what prints is black on white. */}
      <article
        data-scheme="light"
        className="flex flex-col gap-6 rounded-lg border border-border bg-background px-8 py-10 font-reading text-foreground print:rounded-none print:border-0 print:px-0 print:py-0"
      >
        {tipo === "repasse" ? (
          <>
            <header className="flex flex-col gap-1 text-center">
              <h1 className="text-title font-semibold tracking-[-0.01em]">Recibo de repasse</h1>
              <p className="text-small text-muted-foreground tabular-nums">Nº {payout.number}</p>
            </header>
            <p className="leading-relaxed">
              Recebi de <strong>{office}</strong>
              {officeDocument}
              {creci !== "" && `, ${creci}`}, que administra os imóveis abaixo, a importância de{" "}
              <strong>{formatMoney(payout.total)}</strong>, referente ao repasse dos aluguéis e lançamentos
              discriminados neste recibo, transferida em {formatLongDate(payout.paidOn)}
              {payout.method !== "" && ` por ${methodLabel(payout.method)}`}.
            </p>
            <Statement payout={payout} />
            <Signature place={formatLongDate(payout.paidOn)} name={payout.person.name} detail={beneficiaryDocument} />
          </>
        ) : (
          <>
            <header className="flex flex-col gap-1 text-center">
              <h1 className="text-title font-semibold tracking-[-0.01em]">Recibo de taxa de administração</h1>
              <p className="text-small text-muted-foreground tabular-nums">Referente ao repasse Nº {payout.number}</p>
            </header>
            <p className="leading-relaxed">
              Recebi de <strong>{beneficiary}</strong>, a importância de <strong>R$ {formatMoneyInput(fee)}</strong>,
              referente à taxa de administração dos aluguéis dos imóveis abaixo, descontada no repasse Nº {payout.number}{" "}
              de {formatLongDate(payout.paidOn)}.
            </p>
            <ul className="flex flex-col gap-1 text-small">
              {groups.map((g) => {
                const groupFee = totalsByKind(g.entries).admin_fee;
                if (groupFee === 0 || g.address === null) return null;
                return (
                  <li key={g.propertyId} className="flex justify-between gap-4 border-b border-border py-1.5 tabular-nums">
                    <span>
                      {addressLine(g.address)}, {addressPlace(g.address)}
                    </span>
                    <span>R$ {formatMoneyInput(groupFee)}</span>
                  </li>
                );
              })}
            </ul>
            <Signature
              place={formatLongDate(payout.paidOn)}
              name={office}
              detail={[administrator === null ? "" : `${administrator.kind === "company" ? "CNPJ" : "CPF"} ${administrator.document}`, creci]
                .filter((x) => x !== "")
                .join(" · ")}
            />
          </>
        )}
      </article>
    </div>
  );
}

function Signature({ place, name, detail }: { readonly place: string; readonly name: string; readonly detail: string }) {
  return (
    <footer className="mt-6 flex flex-col items-center gap-10 text-center print:break-inside-avoid">
      <p className="self-start">{place}.</p>
      <div className="flex w-72 max-w-full flex-col items-center gap-1 border-t border-foreground pt-2">
        <span className="font-medium">{name}</span>
        {detail !== "" && <span className="text-small text-muted-foreground tabular-nums">{detail}</span>}
      </div>
    </footer>
  );
}
