import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";

/**
 * Adjusted from the shadcn default to the design system's field: 38px tall,
 * 8px radius, a solid `--color-input` ground, and a focus ring at the alpha the
 * design specifies. The generated defaults were 32px, 12px and transparent.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-[38px] w-full min-w-0 rounded-md border border-border-strong bg-input px-3 py-2",
        "text-sm text-foreground transition-colors outline-none",
        "placeholder:text-faint",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
        "disabled:cursor-not-allowed disabled:text-disabled-foreground",
        "aria-invalid:border-destructive/70 aria-invalid:focus-visible:ring-destructive/20",
        "file:inline-flex file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
