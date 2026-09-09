import { useId } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
