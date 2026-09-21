import { useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { messageFor, summaryOf, type Failure } from "@/application/result";
import { FormField } from "@/components/form-field";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import {
  ADMINISTRATOR_KINDS,
  emptyAdministrator,
  validateAdministrator,
  type Administrator,
  type AdministratorKind,
} from "@/domain/administrator";
import { maskCNPJ, maskCPF } from "@/domain/person";
import { setAdministrator } from "@/server/organization";

/**
 * Who signs the receipts the office hands to owners: the payout receipt and
 * the administration fee receipt name the administrator, a self-employed
 * broker or a company, with the CPF or CNPJ and the CRECI. Every member sees
 * it; an administrator changes it.
 */
export function AdministratorSection({
  administrator,
  isAdmin,
}: {
  readonly administrator: Administrator | null;
  readonly isAdmin: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState<Administrator>(administrator ?? emptyAdministrator());
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);

  const local = attempted ? validateAdministrator(value) : [];
  const error = (field: string) => messageFor(failure, field) ?? local.find((p) => p.field === field)?.message;
  const kindLabel = ADMINISTRATOR_KINDS.find(([k]) => k === value.kind)?.[1] ?? "";

  function change(patch: Partial<Administrator>) {
    setFailure(null);
    setSaved(false);
    setValue((current) => ({ ...current, ...patch }));
  }

  async function onSave() {
    setAttempted(true);
    if (validateAdministrator(value).length > 0) return;
    setPending(true);
    setFailure(null);
    const result = await setAdministrator({ data: value });
    setPending(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setValue(result.value);
    setSaved(true);
    await router.invalidate();
  }

  return (
    <section
      aria-labelledby="administrator-title"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card px-5 py-4"
    >
      <h2 id="administrator-title" className="text-sm font-semibold">
        Administrador dos aluguéis
      </h2>
      <p className="font-reading text-small text-muted-foreground">
        Quem assina os recibos entregues aos proprietários: o recibo de repasse e o recibo da taxa de administração.
      </p>

      {!isAdmin ? (
        administrator === null ? (
          <p className="text-small text-muted-foreground">Ainda não informado. Um administrador do escritório preenche.</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-small">
            <dt className="text-muted-foreground">Tipo</dt>
            <dd>{kindLabel}</dd>
            <dt className="text-muted-foreground">{administrator.kind === "company" ? "CNPJ" : "CPF"}</dt>
            <dd className="tabular-nums">{administrator.document}</dd>
            <dt className="text-muted-foreground">CRECI</dt>
            <dd>{administrator.creci === "" ? "Não informado" : administrator.creci}</dd>
          </dl>
        )
      ) : (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Tipo"
              value={value.kind}
              onBlur={() => {}}
              onChange={(next) => change({ kind: next as AdministratorKind, document: "" })}
              options={ADMINISTRATOR_KINDS}
            />
            <FormField
              name="administrator_document"
              label={value.kind === "company" ? "CNPJ" : "CPF"}
              placeholder={value.kind === "company" ? "00.000.000/0000-00" : "000.000.000-00"}
              autoComplete="off"
              value={value.document}
              error={error("document")}
              onChange={(event) => {
                const next = event.currentTarget.value;
                change({ document: value.kind === "company" ? maskCNPJ(next) : maskCPF(next) });
              }}
            />
            <FormField
              name="administrator_creci"
              label="CRECI"
              placeholder={value.kind === "company" ? "CRECI 12345-J/SP" : "CRECI 12345-F/SP"}
              autoComplete="off"
              hint="Opcional. Aparece nos recibos."
              value={value.creci}
              error={error("creci")}
              onChange={(event) => {
                const next = event.currentTarget.value;
                change({ creci: next });
              }}
            />
          </div>
          {failure !== null && failure.kind !== "validation" && (
            <p role="alert" className="text-small text-destructive-soft">
              {summaryOf(failure)}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? "Salvando..." : "Salvar"}
            </Button>
            {saved && (
              <span role="status" className="text-small text-success-soft">
                Salvo.
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
