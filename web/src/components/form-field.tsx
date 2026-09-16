import { useId } from "react";
import type { AnyFieldApi } from "@tanstack/react-form";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { visibleError } from "@/lib/form";

type FormFieldProps = Parameters<typeof FormField>[0];

/**
 * A `FormField` driven by a TanStack Form field.
 *
 * The field supplies the value, the change and blur handlers and the error,
 * shown by the rule in `visibleError`. An error the server reported wins over
 * the local one: it is the answer that counts. `onEdit` lets the form drop
 * that server answer as soon as the person starts correcting it.
 */
export function BoundFormField({
  field,
  submitted,
  serverError,
  onEdit,
  ...props
}: {
  readonly field: AnyFieldApi;
  /** Whether the form has been submitted, after which every error shows. */
  readonly submitted: boolean;
  readonly serverError?: string | undefined;
  readonly onEdit?: () => void;
} & Omit<FormFieldProps, "name" | "value" | "onChange" | "onBlur" | "error">) {
  const value: unknown = field.state.value;

  return (
    <FormField
      name={field.name}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => {
        // Captured before anything else runs: React nulls currentTarget once
        // the handler returns.
        const next = event.currentTarget.value;
        onEdit?.();
        field.handleChange(next);
      }}
      onBlur={field.handleBlur}
      error={serverError ?? visibleError(field.state.meta, submitted)}
      {...props}
    />
  );
}

/**
 * A labelled input that knows how to show a problem.
 *
 * The wiring matters as much as the look: the message is tied to the input with
 * `aria-describedby` and the invalid state with `aria-invalid`, so a screen
 * reader announces the problem instead of leaving a red border as the only
 * signal.
 */
export function FormField({
  name,
  label,
  type = "text",
  hint,
  error,
  ...props
}: {
  readonly name: string;
  readonly label: string;
  readonly type?: React.HTMLInputTypeAttribute;
  /** Help shown under the field while it is valid. */
  readonly hint?: string;
  /** Replaces the hint when present. */
  readonly error?: string | undefined;
} & Omit<React.ComponentProps<"input">, "name" | "type">) {
  const id = useId();
  const describedBy = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        aria-invalid={error !== undefined}
        {...(message === undefined ? {} : { "aria-describedby": describedBy })}
        {...props}
      />
      {message !== undefined && (
        <p
          id={describedBy}
          className={
            error === undefined
              ? "text-xs text-faint"
              : "text-xs text-destructive"
          }
        >
          {message}
        </p>
      )}
    </div>
  );
}
