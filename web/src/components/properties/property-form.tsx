import { useState, type ReactNode } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { IconScale, IconTrash } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure, type Result } from "@/application/result";
import { FormField } from "@/components/form-field";
import { formPath } from "@/components/people/person-form";
import { PersonPicker } from "@/components/people/person-picker";
import { SelectField } from "@/components/select-field";
import { Button } from "@/components/ui/button";
import { maskZipCode, STATES, type PersonSummary } from "@/domain/person";
import {
  FULL_SHARE,
  formatShare,
  MAX_OWNERS,
  parseShare,
  splitEvenly,
  totalShares,
  validateProperty,
  type OwnerInput,
  type Property,
  type PropertyAddress,
  type PropertyInput,
} from "@/domain/property";
import { blurThenChange, formErrors, visibleError } from "@/lib/form";
import { cn } from "@/lib/utils";

/** The form's values, with a mutable owners list for TanStack Form's helpers. */
type PropertyFormValues = Omit<PropertyInput, "owners"> & { owners: OwnerInput[] };

type AddressField = keyof PropertyAddress;
type RegistrationField = "registry" | "registryOffice" | "municipalRegistration" | "waterCode" | "energyCode";

/**
 * Registering or editing a property.
 *
 * The owners are the part that needs care: each is a person already
 * registered, with a share typed as a percentage. The running total is shown
 * as it changes, and "Dividir igualmente" writes equal shares with the
 * remainder on the last owner, since 100 split in three does not divide.
 */
export function PropertyForm({
  initial,
  owners,
  submitLabel,
  save,
  onSaved,
}: {
  readonly initial: PropertyInput;
  /** Names of the owners already on the property. */
  readonly owners: readonly PersonSummary[];
  readonly submitLabel: string;
  readonly save: (value: PropertyInput) => Promise<Result<Property>>;
  readonly onSaved: (property: Property) => void | Promise<void>;
}) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [names, setNames] = useState<readonly PersonSummary[]>(owners);

  const form = useForm({
    defaultValues: {
      ...initial,
      address: { ...initial.address, zipCode: maskZipCode(initial.address.zipCode) },
      owners: [...initial.owners],
    } as PropertyFormValues,
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) =>
        formErrors(validateProperty(value).map((p) => ({ field: formPath(p.field), message: p.message }))),
    },
    onSubmit: async ({ value }) => {
      setFailure(null);
      const result = await save(value);
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      await onSaved(result.value);
    },
  });

  const ownerValues = useStore(form.store, (s) => s.values.owners);
  const pending = useStore(form.store, (s) => s.isSubmitting);
  const submitted = attempted || form.state.submissionAttempts > 0;
  const serverError = (apiField: string) => messageFor(failure, apiField);
  const summary = summaryOf(failure, { not_found: "Este imóvel não existe mais." });

  const total = totalShares(ownerValues);
  const allParse = ownerValues.every((o) => parseShare(o.share) !== null);

  const addressText = (
    name: AddressField,
    label: string,
    options: { placeholder?: string; autoComplete?: string; mask?: (v: string) => string; inputMode?: "numeric" } = {},
  ) => {
    const apiField = `address.${name === "zipCode" ? "zip_code" : name}`;
    return (
      <form.Field name={`address.${name}`}>
        {(field) => (
          <FormField
            name={apiField}
            label={label}
            {...(options.placeholder === undefined ? {} : { placeholder: options.placeholder })}
            {...(options.inputMode === undefined ? {} : { inputMode: options.inputMode })}
            autoComplete={options.autoComplete ?? "off"}
            value={field.state.value}
            error={serverError(apiField) ?? visibleError(field.state.meta, submitted)}
            onBlur={field.handleBlur}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setFailure(null);
              field.handleChange(options.mask ? options.mask(next) : next);
            }}
          />
        )}
      </form.Field>
    );
  };

  const registrationText = (name: RegistrationField, apiField: string, label: string, placeholder: string, hint?: string) => (
    <form.Field name={name}>
      {(field) => (
        <FormField
          name={apiField}
          label={label}
          placeholder={placeholder}
          {...(hint === undefined ? {} : { hint })}
          autoComplete="off"
          value={field.state.value}
          error={serverError(apiField) ?? visibleError(field.state.meta, submitted)}
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

  const ownersError = serverError("owners") ?? visibleError(form.getFieldMeta("owners") ?? { isBlurred: false, errors: [] }, submitted);

  return (
    <form
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setAttempted(true);
        void form.handleSubmit();
      }}
    >
      {summary !== null && (
        <p role="alert" className="rounded-md border border-destructive/35 bg-destructive/5 px-4 py-3 text-small text-destructive-soft">
          {summary}
        </p>
      )}

      <Section title="Endereço">
        <div className="grid gap-4 md:grid-cols-6">
          <div className="md:col-span-2">
            {addressText("zipCode", "CEP", { placeholder: "00000-000", autoComplete: "postal-code", mask: maskZipCode, inputMode: "numeric" })}
          </div>
          <div className="md:col-span-2">
            <form.Field name="address.state">
              {(field) => (
                <SelectField
                  label="UF"
                  value={field.state.value}
                  error={serverError("address.state") ?? visibleError(field.state.meta, submitted)}
                  onBlur={field.handleBlur}
                  onChange={(v) => field.handleChange(v)}
                  options={[["", "Escolha"], ...STATES.map((s) => [s, s] as const)]}
                />
              )}
            </form.Field>
          </div>
          <div className="md:col-span-2">
            {addressText("city", "Cidade", { placeholder: "Bebedouro", autoComplete: "address-level2" })}
          </div>
          <div className="md:col-span-4">
            {addressText("street", "Logradouro", { placeholder: "Rua, avenida, travessa", autoComplete: "address-line1" })}
          </div>
          <div className="md:col-span-2">{addressText("number", "Número", { placeholder: "120 ou s/n" })}</div>
          <div className="md:col-span-3">
            {addressText("complement", "Complemento", { placeholder: "Apto 12, bloco B", autoComplete: "address-line2" })}
          </div>
          <div className="md:col-span-3">{addressText("district", "Bairro", { placeholder: "Centro" })}</div>
        </div>
      </Section>

      <Section title="Registro e contas">
        <div className="grid gap-4 md:grid-cols-2">
          {registrationText("registry", "registry", "Matrícula", "12.345")}
          {registrationText("registryOffice", "registry_office", "Cartório de registro", "1º Cartório de Registro de Imóveis")}
          {registrationText("municipalRegistration", "municipal_registration", "Inscrição do IPTU", "01.02.003.0045")}
          <div className="hidden md:block" />
          {registrationText("waterCode", "water_code", "Código da conta de água", "Número da ligação")}
          {registrationText("energyCode", "energy_code", "Código da conta de energia", "Número da instalação")}
        </div>
      </Section>

      <form.Field name="owners" mode="array">
        {(list) => (
          <fieldset className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4">
            <legend className="px-1 text-sm font-semibold">Proprietários</legend>

            {list.state.value.length === 0 ? (
              <p className="text-small text-muted-foreground">Nenhum proprietário escolhido.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {list.state.value.map((owner, index) => (
                  <li key={owner.personId} className="flex flex-wrap items-end gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1 self-center truncate text-small font-medium">
                      {names.find((p) => p.id === owner.personId)?.name ?? "Pessoa"}
                    </span>
                    <form.Field name={`owners[${index}].share`}>
                      {(field) => (
                        <div className="w-32">
                          <FormField
                            name={`owners.${index}.share`}
                            label="Parte (%)"
                            inputMode="decimal"
                            placeholder="50"
                            autoComplete="off"
                            value={field.state.value}
                            error={serverError(`owners[${index}].share`) ?? visibleError(field.state.meta, submitted)}
                            onBlur={field.handleBlur}
                            onChange={(event) => {
                              const next = event.currentTarget.value;
                              setFailure(null);
                              field.handleChange(next);
                            }}
                          />
                        </div>
                      )}
                    </form.Field>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remover ${names.find((p) => p.id === owner.personId)?.name ?? "proprietário"}`}
                      onClick={() => list.removeValue(index)}
                    >
                      <IconTrash aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {list.state.value.length > 0 && (
              <div className="flex flex-wrap items-center gap-3">
                <p
                  aria-live="polite"
                  className={cn(
                    "font-reading text-small tabular-nums",
                    allParse && total === FULL_SHARE ? "text-success-soft" : "text-muted-foreground",
                  )}
                >
                  Soma das partes: {allParse ? `${formatShare(total)}%` : "confira os valores"}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  onClick={() => {
                    setFailure(null);
                    splitEvenly(list.state.value.length).forEach((share, index) => {
                      form.setFieldValue(`owners[${index}].share`, share);
                    });
                  }}
                >
                  <IconScale data-icon="inline-start" aria-hidden="true" />
                  Dividir igualmente
                </Button>
              </div>
            )}

            {ownersError !== undefined && <p className="text-xs text-destructive">{ownersError}</p>}

            {list.state.value.length < MAX_OWNERS && (
              <PersonPicker
                label="Adicionar proprietário"
                hint="Pessoas físicas ou jurídicas já cadastradas."
                multiple
                chosen={[]}
                exclude={list.state.value.map((o) => o.personId)}
                onChange={(people) => {
                  setFailure(null);
                  setNames((current) => [...current, ...people]);
                  for (const person of people) {
                    // The first owner takes the whole property; later ones
                    // start empty, for a share to be typed or split.
                    list.pushValue({ personId: person.id, share: list.state.value.length === 0 ? "100" : "" });
                  }
                }}
              />
            )}
          </fieldset>
        )}
      </form.Field>

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Salvando..." : submitLabel}
      </Button>
    </form>
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
