import { useId } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * A native select drawn like the text inputs. Native, because a phone then
 * shows its own picker, and 27 UFs are faster to choose there than in a
 * custom list.
 */
export function SelectField({
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
