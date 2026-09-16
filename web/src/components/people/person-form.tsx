import { useId, useState, type ReactNode } from "react";
import { useForm, useStore } from "@tanstack/react-form";
import { IconPlus, IconTrash } from "@tabler/icons-react";

import { messageFor, summaryOf, type Failure, type Result } from "@/application/result";
import { FormField } from "@/components/form-field";
import { PersonPicker } from "@/components/people/person-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  ADDRESS_KIND_LABELS,
  ADDRESS_KINDS,
  GENDER_LABELS,
  hasPartner,
  KIND_LABELS,
  MARITAL_STATUS_LABELS,
  MARITAL_STATUSES,
  MAX_ADDRESSES,
  maskCNPJ,
  maskCPF,
  maskPhone,
  maskZipCode,
  PROPERTY_REGIME_LABELS,
  PROPERTY_REGIMES,
  STATES,
  emptyAddress,
  type Address,
  validatePerson,
  type Person,
  type PersonInput,
  type PersonKind,
  type PersonSummary,
} from "@/domain/person";
import { blurThenChange, formErrors, visibleError } from "@/lib/form";
import { cn } from "@/lib/utils";

/**
 * The form's own values: the domain input with mutable lists, which TanStack
 * Form needs to type its array helpers (a readonly array types them as never).
 */
type PersonFormValues = Omit<PersonInput, "addresses" | "representativeIds"> & {
  addresses: Address[];
  representativeIds: string[];
};

/** "addresses[0].zip_code" as the API names it, "addresses[0].zipCode" as the form does. */
export function formPath(apiField: string): string {
  return apiField.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Registering or editing a person.
 *
 * One form for both kinds. The kind is chosen once, when registering, and the
 * sections change with it: an individual has a CPF, a civil status and maybe a
 * spouse; a company has a CNPJ, a trade name and its representatives. Only the
 * fields of the chosen kind are sent.
 */
export function PersonForm({
  initial,
  personId,
  linked,
  kindLocked,
  submitLabel,
  save,
  onSaved,
}: {
  readonly initial: PersonInput;
  /** The person being edited, never offered as their own spouse. */
  readonly personId?: string;
  /** Names of the spouse and representatives already linked. */
  readonly linked: readonly PersonSummary[];
  readonly kindLocked: boolean;
  readonly submitLabel: string;
  readonly save: (value: PersonInput) => Promise<Result<Person>>;
  readonly onSaved: (person: Person) => void | Promise<void>;
}) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [names, setNames] = useState<readonly PersonSummary[]>(linked);

  const form = useForm({
    // The API answers phone and CEP as bare digits; the form shows them the
    // way they are typed.
    defaultValues: {
      ...initial,
      phone: maskPhone(initial.phone),
      addresses: initial.addresses.map((address) => ({ ...address, zipCode: maskZipCode(address.zipCode) })),
      representativeIds: [...initial.representativeIds],
    } as PersonFormValues,
    validationLogic: blurThenChange,
    validators: {
      onDynamic: ({ value }) =>
        formErrors(validatePerson(value).map((p) => ({ field: formPath(p.field), message: p.message }))),
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

  const kind = useStore(form.store, (s) => s.values.kind);
  const maritalStatus = useStore(form.store, (s) => s.values.maritalStatus);
  const pending = useStore(form.store, (s) => s.isSubmitting);
  const submitted = attempted || form.state.submissionAttempts > 0;

  // The server's answer for a field, named as the API names it.
  const serverError = (apiField: string) => messageFor(failure, apiField);
  const summary = summaryOf(failure, {
    not_found: "Este cadastro não existe mais.",
  });

  /** A text field bound to the form, with an optional mask applied as typed. */
  const text = (
    name: Exclude<keyof PersonInput, "kind" | "addresses" | "representativeIds" | "maritalStatus" | "propertyRegime" | "gender">,
    apiField: string,
    label: string,
    options: {
      mask?: (v: string) => string;
      hint?: string;
      placeholder?: string;
      type?: string;
      autoComplete?: string;
      inputMode?: "numeric" | "email" | "tel" | "text";
    } = {},
  ) => (
    <form.Field name={name}>
      {(field) => (
        <FormField
          name={name}
          label={label}
          type={options.type ?? "text"}
          {...(options.hint === undefined ? {} : { hint: options.hint })}
          {...(options.placeholder === undefined ? {} : { placeholder: options.placeholder })}
          {...(options.autoComplete === undefined ? { autoComplete: "off" } : { autoComplete: options.autoComplete })}
          {...(options.inputMode === undefined ? {} : { inputMode: options.inputMode })}
          value={typeof field.state.value === "string" ? field.state.value : ""}
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

      {!kindLocked && (
        <form.Field name="kind">
          {(field) => (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-small font-medium">Tipo de cadastro</legend>
              <div className="flex flex-wrap gap-2">
                {(["individual", "company"] as const satisfies readonly PersonKind[]).map((option) => (
                  <label
                    key={option}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3.5 py-2 text-small font-medium",
                      "has-focus-visible:ring-[3px] has-focus-visible:ring-ring/20",
                      field.state.value === option
                        ? "border-primary-text bg-muted text-foreground"
                        : "border-border text-muted-foreground hover:bg-row-hover",
                    )}
                  >
                    <input
                      type="radio"
                      name="kind"
                      value={option}
                      className="sr-only"
                      checked={field.state.value === option}
                      onChange={() => field.handleChange(option)}
                    />
                    {KIND_LABELS[option]}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </form.Field>
      )}

      <Section title="Identificação">
        {text("name", "name", kind === "company" ? "Razão social" : "Nome completo", {
          autoComplete: kind === "company" ? "organization" : "name",
          placeholder: kind === "company" ? "Exemplo Imóveis Ltda" : "Nome e sobrenome, sem abreviar",
        })}
        {kind === "individual" ? (
          <>
            {text("cpf", "cpf", "CPF", { mask: maskCPF, inputMode: "numeric", placeholder: "000.000.000-00", hint: "Opcional, mas necessário para o contrato." })}
            {text("birthDate", "birth_date", "Data de nascimento", { type: "date" })}
            {text("nationality", "nationality", "Nacionalidade", { placeholder: "brasileira" })}
            {text("occupation", "occupation", "Profissão", { placeholder: "Engenheira civil" })}
            <form.Field name="gender">
              {(field) => (
                <SelectField
                  label="Gênero"
                  hint="Usado só na concordância do texto do contrato."
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(v) => field.handleChange(v === "female" || v === "male" ? v : "")}
                  options={[
                    ["", "Não informar"],
                    ["female", GENDER_LABELS.female],
                    ["male", GENDER_LABELS.male],
                  ]}
                />
              )}
            </form.Field>
          </>
        ) : (
          <>
            {text("tradeName", "trade_name", "Nome fantasia", { placeholder: "Exemplo Imóveis" })}
            {text("cnpj", "cnpj", "CNPJ", { mask: maskCNPJ, placeholder: "00.000.000/0000-00", hint: "Aceita o CNPJ alfanumérico." })}
          </>
        )}
      </Section>

      <Section title="Contato">
        {text("email", "email", "E-mail", { type: "email", inputMode: "email", placeholder: "nome@exemplo.com" })}
        {text("phone", "phone", "Telefone", { mask: maskPhone, inputMode: "tel", placeholder: "(00) 00000-0000", hint: "Com DDD." })}
      </Section>

      {kind === "individual" && (
        <Section title="Estado civil">
          <form.Field name="maritalStatus">
            {(field) => (
              <SelectField
                label="Estado civil"
                value={field.state.value}
                error={serverError("marital_status")}
                onBlur={field.handleBlur}
                onChange={(v) => {
                  setFailure(null);
                  const status = MARITAL_STATUSES.find((s) => s === v) ?? "";
                  field.handleChange(status);
                  // A regime and a spouse only exist with a partner; leaving
                  // them set would be refused on save.
                  if (!hasPartner(status)) {
                    form.setFieldValue("propertyRegime", "");
                    form.setFieldValue("spouseId", "");
                  }
                }}
                options={[["", "Não informado"], ...MARITAL_STATUSES.map((s) => [s, MARITAL_STATUS_LABELS[s]] as const)]}
              />
            )}
          </form.Field>

          {hasPartner(maritalStatus) && (
            <>
              <form.Field name="propertyRegime">
                {(field) => (
                  <SelectField
                    label="Regime de bens"
                    value={field.state.value}
                    error={serverError("property_regime") ?? visibleError(field.state.meta, submitted)}
                    onBlur={field.handleBlur}
                    onChange={(v) => field.handleChange(PROPERTY_REGIMES.find((r) => r === v) ?? "")}
                    options={[["", "Não informado"], ...PROPERTY_REGIMES.map((r) => [r, PROPERTY_REGIME_LABELS[r]] as const)]}
                  />
                )}
              </form.Field>
              <div className="md:col-span-2">
                <form.Field name="spouseId">
                  {(field) => (
                    <PersonPicker
                      label="Cônjuge ou companheiro(a)"
                      hint="Precisa estar cadastrado como casado(a) ou em união estável. O vínculo aparece nos dois cadastros."
                      error={serverError("spouse_id") ?? visibleError(field.state.meta, submitted)}
                      multiple={false}
                      exclude={personId === undefined ? [] : [personId]}
                      chosen={names.filter((p) => p.id === field.state.value)}
                      onChange={(people) => {
                        setFailure(null);
                        setNames((current) => [...current, ...people]);
                        field.handleChange(people[0]?.id ?? "");
                      }}
                    />
                  )}
                </form.Field>
              </div>
            </>
          )}
        </Section>
      )}

      {kind === "company" && (
        <Section title="Representantes">
          <div className="md:col-span-2">
            <form.Field name="representativeIds">
              {(field) => (
                <PersonPicker
                  label="Quem representa a empresa"
                  hint="Pessoas físicas já cadastradas."
                  error={serverError("representative_ids") ?? visibleError(field.state.meta, submitted)}
                  multiple
                  exclude={personId === undefined ? [] : [personId]}
                  chosen={field.state.value
                    .map((id) => names.find((p) => p.id === id))
                    .filter((p): p is PersonSummary => p !== undefined)}
                  onChange={(people) => {
                    setFailure(null);
                    setNames((current) => [...current, ...people]);
                    field.handleChange(people.map((p) => p.id));
                  }}
                />
              )}
            </form.Field>
          </div>
        </Section>
      )}

      <form.Field name="addresses" mode="array">
        {(list) => (
          <fieldset className="flex flex-col gap-4 rounded-lg border border-border bg-card px-5 py-4">
            <legend className="px-1 text-sm font-semibold">Endereços</legend>
            {list.state.value.length === 0 && (
              <p className="text-small text-muted-foreground">Nenhum endereço cadastrado.</p>
            )}
            {(serverError("addresses") ?? visibleError(list.state.meta, submitted)) !== undefined && (
              <p className="text-xs text-destructive">{serverError("addresses") ?? visibleError(list.state.meta, submitted)}</p>
            )}

            {list.state.value.map((_, index) => (
              <div
                key={index}
                className="flex flex-col gap-4 border-t border-border pt-4 first-of-type:border-t-0 first-of-type:pt-0"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-micro tracking-[0.1em] text-faint uppercase">
                    Endereço {index + 1}
                  </span>
                  <form.Field name={`addresses[${index}].isPrimary`}>
                    {(field) => (
                      <PrimaryCheckbox
                        checked={field.state.value}
                        onChange={(checked) => {
                          // One primary: marking this one clears the others.
                          if (checked) {
                            list.state.value.forEach((__, other) => {
                              if (other !== index) form.setFieldValue(`addresses[${other}].isPrimary`, false);
                            });
                          }
                          field.handleChange(checked);
                        }}
                      />
                    )}
                  </form.Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-muted-foreground"
                    onClick={() => list.removeValue(index)}
                  >
                    <IconTrash data-icon="inline-start" aria-hidden="true" />
                    Remover
                  </Button>
                </div>

                <div className="grid gap-4 md:grid-cols-6">
                  <div className="md:col-span-2">
                    <form.Field name={`addresses[${index}].kind`}>
                      {(field) => (
                        <SelectField
                          label="Uso"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(v) => field.handleChange(ADDRESS_KINDS.find((k) => k === v) ?? "residential")}
                          options={ADDRESS_KINDS.map((k) => [k, ADDRESS_KIND_LABELS[k]] as const)}
                        />
                      )}
                    </form.Field>
                  </div>
                  <div className="md:col-span-2">
                    <form.Field name={`addresses[${index}].zipCode`}>
                      {(field) => (
                        <FormField
                          name={`addresses.${index}.zip_code`}
                          label="CEP"
                          placeholder="00000-000"
                          inputMode="numeric"
                          autoComplete="postal-code"
                          value={field.state.value}
                          error={serverError(`addresses[${index}].zip_code`) ?? visibleError(field.state.meta, submitted)}
                          onBlur={field.handleBlur}
                          onChange={(event) => {
                            const next = event.currentTarget.value;
                            field.handleChange(maskZipCode(next));
                          }}
                        />
                      )}
                    </form.Field>
                  </div>
                  <div className="md:col-span-2">
                    <form.Field name={`addresses[${index}].state`}>
                      {(field) => (
                        <SelectField
                          label="UF"
                          value={field.state.value}
                          error={serverError(`addresses[${index}].state`) ?? visibleError(field.state.meta, submitted)}
                          onBlur={field.handleBlur}
                          onChange={(v) => field.handleChange(v)}
                          options={[["", "Escolha"], ...STATES.map((s) => [s, s] as const)]}
                        />
                      )}
                    </form.Field>
                  </div>
                  <AddressText form={form} index={index} name="street" apiName="street" label="Logradouro" placeholder="Rua, avenida, travessa" span="md:col-span-4" submitted={submitted} serverError={serverError} autoComplete="address-line1" />
                  <AddressText form={form} index={index} name="number" apiName="number" label="Número" placeholder="120 ou s/n" span="md:col-span-2" submitted={submitted} serverError={serverError} />
                  <AddressText form={form} index={index} name="complement" apiName="complement" label="Complemento" placeholder="Apto 12, bloco B" span="md:col-span-2" submitted={submitted} serverError={serverError} autoComplete="address-line2" />
                  <AddressText form={form} index={index} name="district" apiName="district" label="Bairro" placeholder="Centro" span="md:col-span-2" submitted={submitted} serverError={serverError} />
                  <AddressText form={form} index={index} name="city" apiName="city" label="Cidade" placeholder="Bebedouro" span="md:col-span-2" submitted={submitted} serverError={serverError} autoComplete="address-level2" />
                </div>
              </div>
            ))}

            {list.state.value.length < MAX_ADDRESSES && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => list.pushValue(emptyAddress(list.state.value.length === 0))}
              >
                <IconPlus data-icon="inline-start" aria-hidden="true" />
                Adicionar endereço
              </Button>
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
    <fieldset className="grid gap-4 rounded-lg border border-border bg-card px-5 py-4 md:grid-cols-2">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

type AddressName = "street" | "number" | "complement" | "district" | "city";

function AddressText({
  form,
  index,
  name,
  apiName,
  label,
  span,
  submitted,
  serverError,
  autoComplete,
  placeholder,
}: {
  // The form's full type is long and generic; this helper only binds fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly form: { Field: any };
  readonly index: number;
  readonly name: AddressName;
  readonly apiName: string;
  readonly label: string;
  readonly span: string;
  readonly submitted: boolean;
  readonly serverError: (field: string) => string | undefined;
  readonly autoComplete?: string;
  readonly placeholder?: string;
}) {
  const Field = form.Field;
  return (
    <div className={span}>
      <Field name={`addresses[${index}].${name}`}>
        {(field: { state: { value: string; meta: Parameters<typeof visibleError>[0] }; handleBlur: () => void; handleChange: (v: string) => void }) => (
          <FormField
            name={`addresses.${index}.${apiName}`}
            label={label}
            autoComplete={autoComplete ?? "off"}
            {...(placeholder === undefined ? {} : { placeholder })}
            value={field.state.value}
            error={serverError(`addresses[${index}].${apiName}`) ?? visibleError(field.state.meta, submitted)}
            onBlur={field.handleBlur}
            onChange={(event) => {
              const next = event.currentTarget.value;
              field.handleChange(next);
            }}
          />
        )}
      </Field>
    </div>
  );
}

function PrimaryCheckbox({ checked, onChange }: { readonly checked: boolean; readonly onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id} className="font-normal text-muted-foreground">
        Principal
      </Label>
    </div>
  );
}

/**
 * A native select drawn like the text inputs. Native, because a phone then
 * shows its own picker, and 27 UFs are faster to choose there than in a
 * custom list.
 */
function SelectField({
  label,
  hint,
  error,
  value,
  options,
  onChange,
  onBlur,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (value: string) => void;
  readonly onBlur: () => void;
}) {
  const id = useId();
  const message = error ?? hint;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        aria-invalid={error !== undefined}
        {...(message === undefined ? {} : { "aria-describedby": `${id}-message` })}
        onBlur={onBlur}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next);
        }}
        className={cn(
          "h-9.5 w-full min-w-0 rounded-md border border-input-border bg-input px-3 text-sm text-foreground outline-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
          "aria-invalid:border-destructive/70",
        )}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      {message !== undefined && (
        <p id={`${id}-message`} className={error === undefined ? "text-xs text-faint" : "text-xs text-destructive"}>
          {message}
        </p>
      )}
    </div>
  );
}
