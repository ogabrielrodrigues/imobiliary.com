/**
 * `cn` merges class names, and has to be told the type scale's names, or it
 * reads `text-small` as a colour and silently drops it next to
 * `text-foreground`. It comes from the shared package, where the scale and its
 * test live together.
 *
 * Generated shadcn components import `cn` from `@/lib/utils`, which is why
 * this file exists rather than each component importing the package.
 */
export { cn, FONT_SIZES } from "@imobiliary/ui/cn";
