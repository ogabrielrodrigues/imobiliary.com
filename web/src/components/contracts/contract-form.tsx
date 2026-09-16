import { useEffect, useState, type ReactNode } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { IconArrowLeft, IconArrowRight } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure, type Result } from "@/application/result";
import { FormField } from "@/components/form-field";
import { PersonPicker } from "@/components/people/person-picker";
import { PropertyPicker } from "@/components/properties/property-picker";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  formatDate,
  formatMoney,
  formatMoneyInput,
  guaranteeLabel,
  GUARANTEES,
  indexLabel,
  INDEXES,
  NOTICES,
  parseMoney,
  ROLE_LABELS,
  stepOfField,
  validateContract,
  type AdjustmentIndex,
  type Contract,
  type ContractInput,
  type ContractPreview,
  type ContractStep,
  type GuaranteeKind,
  type NoticeCode,
} from "@/domain/contract";
import type { PersonSummary } from "@/domain/person";
import { addressLine, type PropertySummary } from "@/domain/property";
import { blurThenChange, formErrors, submitForm, visibleError } from "@/lib/form";
import { cn } from "@/lib/utils";
import { getProperty } from "@/server/properties";
import { previewContract } from "@/server/contracts";

/** The form's values, with mutable lists for TanStack Form. */
type ContractFormValues = Omit<
  ContractInput,
  "landlordIds" | "tenantIds" | "guarantorIds" | "guarantorSpouseIds" | "acknowledgments"
> & {
  landlordIds: string[];
  tenantIds: string[];
  guarantorIds: string[];
  guarantorSpouseIds: string[];
  acknowledgments: NoticeCode[];
};

type PartyField = "landlordIds" | "tenantIds" | "guarantorIds" | "guarantorSpouseIds";
type TextField = "registry" | "rent" | "depositAmount" | "adminFee" | "latePenaltyRate" | "lateInterestRate" | "dueDay";
type DateField = "signedOn" | "startsOn" | "expiresOn";

const STEPS: readonly { readonly key: ContractStep; readonly label: string }[] = [
  { key: "property", label: "Imóvel" },
  { key: "parties", label: "Partes" },
  { key: "terms", label: "Valores e prazo" },
  { key: "review", label: "Revisão" },
];

/**
 * Registering or editing a contract, in four steps.
 *
 * Each step checks only its own fields before moving on; the review asks the
 * API for the schedule and for the notices the terms raise, each of which must
 * be acknowledged before saving. An error the API returns on save sends the
 * person back to the step that holds the field.
 */
export function ContractForm({
  initial,
  initialProperty,
  initialPeople,
  submitLabel,
  save,
  onSaved,
}: {
  readonly initial: ContractInput;
  readonly initialProperty: PropertySummary | null;
  /** Names of the parties already on the contract. */
  readonly initialPeople: readonly PersonSummary[];
  readonly submitLabel: string;
  readonly save: (value: ContractInput) => Promise<Result<Contract>>;
  readonly onSaved: (contract: Contract) => void | Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [attempted, setAttempted] = useState<ReadonlySet<number>>(new Set());
  const [failure, setFailure] = useState<Failure | null>(null);
  const [property, setProperty] = useState<PropertySummary | null>(initialProperty);
  const [people, setPeople] = useState<ReadonlyMap<string, PersonSummary>>(
    new Map(initialPeople.map((p) => [p.id, p])),
  );
  const [preview, setPreview] = useState<Result<ContractPreview> | null>(null);
  const [noticeError, setNoticeError] = useState(false);

  const form = useForm({
    defaultValues: {
      ...initial,
      landlordIds: [...initial.landlordIds],
      tenantIds: [...initial.tenantIds],
      guarantorIds: [...initial.guarantorIds],
      guarantorSpouseIds: [...initial.guarantorSpouseIds],
      acknowledgments: [...initial.acknowledgments],
    } as ContractFormValues,
    validationLogic: blurThenChange,
    validators: { onDynamic: ({ value }) => formErrors(validateContract(value)) },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await save(value);
      if (!result.ok) {
        setFailure(result.failure);
        goToFailure(result.failure);
        return;
      }
      await onSaved(result.value);
    },
  });

  const values = useStore(form.store, (s) => s.values);
  const pending = useStore(form.store, (s) => s.isSubmitting);
  const current = STEPS[step]?.key ?? "property";
  const shown = attempted.has(step) || form.state.submissionAttempts > 0;
  const serverError = (field: string) => messageFor(failure, field);

  /** Back to the first step holding a field the API refused. */
  function goToFailure(f: Failure) {
    if (f.kind !== "validation") return;
    const steps = f.fields.map((field) => STEPS.findIndex((s) => s.key === stepOfField(field.field)));
    const first = Math.min(...steps.filter((i) => i >= 0));
    if (Number.isFinite(first)) {
      setAttempted((a) => new Set([...a, first]));
      setStep(first);
    }
  }

  // The review always shows what the API makes of the current values.
  useEffect(() => {
    if (current !== "review") return;
    let cancelled = false;
    setPreview(null);
    void previewContract({ data: form.state.values }).then((result) => {
      if (cancelled) return;
      setPreview(result);
      if (!result.ok) {
        setFailure(result.failure);
        goToFailure(result.failure);
      }
    });
    return () => {
      cancelled = true;
    };
    // Values cannot change while the review is open, except the checkboxes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  async function next() {
    await form.validate("submit");
    setAttempted((a) => new Set([...a, step]));
    const problems = validateContract(form.state.values).filter((p) => stepOfField(p.field) === current);
    if (problems.length === 0) {
      setFailure(null);
      setStep(step + 1);
    }
  }

  function remember(chosen: readonly PersonSummary[]) {
    setPeople((map) => new Map([...map, ...chosen.map((p) => [p.id, p] as const)]));
  }

  async function chooseProperty(chosen: PropertySummary | null) {
    setFailure(null);
    setProperty(chosen);
    form.setFieldValue("propertyId", chosen?.id ?? "");
    if (chosen === null) return;
    // The landlords start as the owners; the person can still change them.
    const result = await getProperty({ data: chosen.id });
    if (!result.ok) return;
    const owners = result.value.owners.map((o) => ({ id: o.personId, kind: o.kind, name: o.name, tradeName: "" }));
    remember(owners);
    form.setFieldValue("landlordIds", owners.map((o) => o.id));
  }

  const text = (
    name: TextField,
    label: string,
    options: { placeholder: string; hint?: string; inputMode?: "numeric" | "decimal"; money?: boolean },
  ) => (
    <form.Field name={name}>
      {(field) => (
        <FormField
          name={name}
          label={label}
          placeholder={options.placeholder}
          {...(options.hint === undefined ? {} : { hint: options.hint })}
          {...(options.inputMode === undefined ? {} : { inputMode: options.inputMode })}
          autoComplete="off"
          value={field.state.value}
          error={serverError(name) ?? visibleError(field.state.meta, shown)}
          onBlur={() => {
            if (options.money) {
              const cents = parseMoney(field.state.value);
              if (cents !== null) field.handleChange(formatMoneyInput(cents));
            }
            field.handleBlur();
          }}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setFailure(null);
            field.handleChange(next);
          }}
        />
      )}
    </form.Field>
  );

  const date = (name: DateField, label: string) => (
    <form.Field name={name}>
      {(field) => (
        <FormField
          name={name}
          label={label}
          type="date"
          value={field.state.value}
          error={serverError(name) ?? visibleError(field.state.meta, shown)}
          onBlur={field.handleBlur}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setFailure(null);
            field.handleChange(next);
          }}
        />
      )}
    </form.Field>
  );

  const party = (name: PartyField, label: string, hint: string, individualsOnly: boolean) => (
    <form.Field name={name}>
      {(field) => (
        <PersonPicker
          label={label}
          hint={hint}
          error={visibleError(field.state.meta, shown)}
          multiple
          {...(individualsOnly ? { kind: "individual" as const } : {})}
          chosen={field.state.value.map(
            (id) => people.get(id) ?? { id, kind: "individual" as const, name: "Pessoa", tradeName: "" },
          )}
          exclude={[]}
          onChange={(chosen) => {
            setFailure(null);
            remember(chosen);
            field.handleChange(chosen.map((p) => p.id));
            field.handleBlur();
          }}
        />
      )}
    </form.Field>
  );

  const summary = summaryOf(failure, { not_found: "Este contrato não existe mais." });

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (current !== "review") {
          void next();
          return;
        }
        const raised = preview?.ok ? preview.value.notices : [];
        if (raised.some((code) => !form.state.values.acknowledgments.includes(code))) {
          setNoticeError(true);
          return;
        }
        void submitForm(form);
      }}
    >
      <ol className="flex flex-wrap gap-2" aria-label="Etapas">
        {STEPS.map((s, index) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={index > step}
              aria-current={index === step ? "step" : undefined}
              onClick={() => setStep(index)}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-1.5 text-small",
                index === step
                  ? "border-border-strong bg-muted font-medium text-foreground"
                  : index < step
                    ? "border-border text-muted-foreground hover:bg-row-hover hover:text-foreground"
                    : "border-border text-disabled-foreground",
              )}
            >
              <span className="font-mono text-micro tabular-nums">{index + 1}</span>
              {s.label}
            </button>
          </li>
        ))}
      </ol>

      {summary !== null && (
        <p role="alert" className="rounded-md border border-destructive/35 bg-destructive/5 px-4 py-3 text-small text-destructive-soft">
          {summary}
        </p>
      )}

      {current === "property" && (
        <Section title="Imóvel">
          <form.Field name="propertyId">
            {(field) => (
              <PropertyPicker
                label="Imóvel locado"
                hint="Os proprietários do imóvel entram como locadores."
                error={serverError("propertyId") ?? visibleError(field.state.meta, shown)}
                chosen={property}
                onChange={(chosen) => void chooseProperty(chosen)}
                onBlur={field.handleBlur}
              />
            )}
          </form.Field>
          <div className="md:w-1/2">
            {text("registry", "Número do contrato", { placeholder: "2026/001", hint: "O número que o escritório usa. Não se repete." })}
          </div>
        </Section>
      )}

      {current === "parties" && (
        <>
          <Section title="Partes">
            {party("landlordIds", "Locadores", "Preenchido com os proprietários do imóvel.", false)}
            {party("tenantIds", "Locatários", "Pessoas físicas ou jurídicas já cadastradas.", false)}
            {serverError("parties") !== undefined && <p className="text-xs text-destructive">{serverError("parties")}</p>}
          </Section>

          <Section title="Garantia">
            <form.Field name="guaranteeKind">
              {(field) => (
                <div className="md:w-1/2">
                  <SelectField
                    label="Modalidade"
                    hint="Uma só por contrato (Lei 8.245/91, art. 37)."
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(next) => {
                      setFailure(null);
                      field.handleChange(next as GuaranteeKind);
                      // Guarantors belong to a surety only.
                      if (next !== "surety") {
                        form.setFieldValue("guarantorIds", []);
                        form.setFieldValue("guarantorSpouseIds", []);
                      }
                    }}
                    options={GUARANTEES}
                  />
                </div>
              )}
            </form.Field>
            <form.Field name="advanceRent">
              {(field) => (
                <div className="md:w-1/2">
                  <SelectField
                    label="Aluguel antecipado"
                    hint={
                      field.state.value === true
                        ? "Cada mês é pago no início, o primeiro na data de início do contrato."
                        : field.state.value === false
                          ? "Cada mês é pago depois de vencido, no dia do vencimento do mês seguinte."
                          : "Se o aluguel de cada mês é pago no início dele."
                    }
                    error={serverError("advanceRent") ?? visibleError(field.state.meta, shown)}
                    value={field.state.value === null ? "" : field.state.value ? "sim" : "nao"}
                    onBlur={field.handleBlur}
                    onChange={(next) => {
                      setFailure(null);
                      field.handleChange(next === "" ? null : next === "sim");
                      // A choice is complete once made; validate it now.
                      field.handleBlur();
                    }}
                    options={[
                      ["", "Escolha"],
                      ["sim", "Sim"],
                      ["nao", "Não"],
                    ]}
                  />
                </div>
              )}
            </form.Field>
            {values.guaranteeKind === "surety" && (
              <>
                {party("guarantorIds", "Fiadores", "Pessoas físicas, que não sejam locatárias.", true)}
                {party(
                  "guarantorSpouseIds",
                  "Cônjuges dos fiadores",
                  "Quem assina junto com um fiador casado.",
                  true,
                )}
              </>
            )}
          </Section>
        </>
      )}

      {current === "terms" && (
        <>
          <Section title="Valores">
            <div className="grid gap-4 md:grid-cols-2">
              {text("rent", "Aluguel (R$)", { placeholder: "1.500,00", inputMode: "decimal", money: true })}
              {values.guaranteeKind === "deposit" &&
                text("depositAmount", "Caução (R$)", { placeholder: "4.500,00", inputMode: "decimal", money: true })}
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {text("adminFee", "Taxa de administração (%)", { placeholder: "10", inputMode: "decimal" })}
              {text("latePenaltyRate", "Multa por atraso (%)", { placeholder: "10", inputMode: "decimal" })}
              {text("lateInterestRate", "Juros ao mês (%)", { placeholder: "1", inputMode: "decimal" })}
            </div>
          </Section>

          <Section title="Prazo e vencimento">
            <div className="grid gap-4 md:grid-cols-3">
              {date("signedOn", "Assinatura")}
              {date("startsOn", "Início")}
              {date("expiresOn", "Fim")}
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {text("dueDay", "Dia do vencimento", {
                placeholder: "10",
                inputMode: "numeric",
                hint: "Vazio para o dia da assinatura.",
              })}
              <form.Field name="adjustmentIndex">
                {(field) => (
                  <SelectField
                    label="Índice de reajuste"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(next) => field.handleChange(next as AdjustmentIndex)}
                    options={INDEXES}
                  />
                )}
              </form.Field>
            </div>
            <p className="font-reading text-small text-muted-foreground">
              {values.advanceRent
                ? "O primeiro aluguel vence no início do contrato. Os seguintes vencem no dia escolhido de cada mês, "
                : "Cada aluguel vence no dia escolhido do mês seguinte ao mês que ele paga, "}
              ou no último dia quando o mês é mais curto.
            </p>
          </Section>
        </>
      )}

      {current === "review" && (
        <Review
          values={values}
          property={property}
          people={people}
          preview={preview}
          acknowledgementsField={
            <form.Field name="acknowledgments">
              {(field) =>
                preview?.ok && preview.value.notices.length > 0 ? (
                  <Section title="Avisos legais">
                    <p className="font-reading text-small text-muted-foreground">
                      Os termos são permitidos, mas trazem um risco. Para registrar o contrato, confirme a ciência de cada
                      aviso. A confirmação fica registrada com seu nome e a data.
                    </p>
                    <ul className="flex flex-col gap-3">
                      {preview.value.notices.map((code) => {
                        const checked = field.state.value.includes(code);
                        const missing = (noticeError || serverError("acknowledgments") !== undefined) && !checked;
                        return (
                          <li
                            key={code}
                            className={cn(
                              "flex flex-col gap-2 rounded-md border px-4 py-3",
                              missing ? "border-destructive/50 bg-destructive/5" : "border-docs/35 bg-docs/5",
                            )}
                          >
                            <p className="text-small font-semibold text-docs-soft">{NOTICES[code].title}</p>
                            <p className="font-reading text-small text-muted-foreground">{NOTICES[code].text}</p>
                            <div className="flex items-start gap-2.5">
                              <Checkbox
                                id={`notice-${code}`}
                                checked={checked}
                                aria-invalid={missing}
                                onCheckedChange={(next) => {
                                  setNoticeError(false);
                                  setFailure(null);
                                  field.handleChange(
                                    next === true
                                      ? [...field.state.value, code]
                                      : field.state.value.filter((c) => c !== code),
                                  );
                                }}
                              />
                              <Label htmlFor={`notice-${code}`} className="text-small font-normal">
                                Estou ciente
                              </Label>
                            </div>
                            {missing && <p className="text-xs text-destructive">Confirme a ciência deste aviso.</p>}
                          </li>
                        );
                      })}
                    </ul>
                  </Section>
                ) : null
              }
            </form.Field>
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        {step > 0 && (
          <Button type="button" variant="secondary" onClick={() => setStep(step - 1)}>
            <IconArrowLeft data-icon="inline-start" aria-hidden="true" />
            Voltar
          </Button>
        )}
        {current !== "review" ? (
          <Button type="submit">
            Continuar
            <IconArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        ) : (
          <Button type="submit" disabled={pending || preview === null || !preview.ok}>
            {pending ? "Salvando..." : submitLabel}
          </Button>
        )}
      </div>
    </form>
  );
}

function Review({
  values,
  property,
  people,
  preview,
  acknowledgementsField,
}: {
  readonly values: ContractFormValues;
  readonly property: PropertySummary | null;
  readonly people: ReadonlyMap<string, PersonSummary>;
  readonly preview: Result<ContractPreview> | null;
  readonly acknowledgementsField: ReactNode;
}) {
  const [allRows, setAllRows] = useState(false);
  const names = (ids: readonly string[]) => ids.map((id) => people.get(id)?.name ?? "Pessoa").join(", ");
  const rows: [string, string][] = [
    ["Imóvel", property === null ? "" : addressLine(property.address)],
    ["Número", values.registry],
    [`${ROLE_LABELS.landlord}es`, names(values.landlordIds)],
    [`${ROLE_LABELS.tenant}s`, names(values.tenantIds)],
    ["Garantia", guaranteeLabel(values.guaranteeKind)],
    ["Aluguel antecipado", values.advanceRent ? "Sim" : "Não"],
  ];
  if (values.guarantorIds.length > 0) rows.push(["Fiadores", names(values.guarantorIds)]);
  if (values.guarantorSpouseIds.length > 0) rows.push(["Cônjuges dos fiadores", names(values.guarantorSpouseIds)]);
  if (values.guaranteeKind === "deposit") rows.push(["Caução", `R$ ${values.depositAmount}`]);
  rows.push(
    ["Aluguel", `R$ ${values.rent}`],
    ["Prazo", `${formatDate(values.startsOn)} a ${formatDate(values.expiresOn)}`],
    ["Assinatura", formatDate(values.signedOn)],
    ["Reajuste", indexLabel(values.adjustmentIndex)],
    ["Administração, multa e juros", `${values.adminFee}%, ${values.latePenaltyRate}% e ${values.lateInterestRate}% ao mês`],
  );

  return (
    <>
      <Section title="Resumo">
        <dl className="grid gap-x-6 gap-y-2 text-small md:grid-cols-[auto_1fr]">
          {rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {preview === null ? (
        <p aria-live="polite" className="text-small text-muted-foreground">
          Calculando os aluguéis...
        </p>
      ) : !preview.ok ? (
        <p role="alert" className="text-small text-destructive-soft">
          {summaryOf(preview.failure) ?? "Não foi possível calcular os aluguéis agora."}
        </p>
      ) : (
        <>
          {acknowledgementsField}
          <Section title={`Aluguéis (${preview.value.schedule.length})`}>
            <table className="w-full text-small tabular-nums">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-4 font-medium">Parcela</th>
                  <th scope="col" className="py-1.5 pr-4 font-medium">Vencimento</th>
                  <th scope="col" className="py-1.5 text-right font-medium">Valor</th>
                </tr>
              </thead>
              <tbody className="font-reading">
                {(allRows ? preview.value.schedule : preview.value.schedule.slice(0, 12)).map((i) => (
                  <tr key={i.sequence} className="border-t border-border">
                    <td className="py-1.5 pr-4">{i.sequence}</td>
                    <td className="py-1.5 pr-4">{formatDate(i.dueOn)}</td>
                    <td className="py-1.5 text-right">{formatMoney(i.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border-strong font-medium">
                  <td className="py-2 pr-4" colSpan={2}>
                    Total do prazo
                  </td>
                  <td className="py-2 text-right">{formatMoney(preview.value.total)}</td>
                </tr>
              </tfoot>
            </table>
            {preview.value.schedule.length > 12 && (
              <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setAllRows(!allRows)}>
                {allRows ? "Mostrar só as 12 primeiras" : `Mostrar todas as ${preview.value.schedule.length}`}
              </Button>
            )}
          </Section>
        </>
      )}
    </>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}
