import { createCn } from "cn/config";

/**
 * The type scale's names, as declared in `styles/app.css` (`--text-<name>`).
 *
 * The class merger has to be told them. Out of the box it only recognises
 * Tailwind's own sizes, so it reads `text-small` as a text colour: next to
 * `text-foreground` it keeps the later one and silently drops the size. That
 * already happened once, to every field label. `utils.test.ts` fails if a token
 * is added to the stylesheet without being listed here.
 */
export const FONT_SIZES = [
  "micro",
  "label",
  "meta",
  "fine",
  "caption",
  "small",
  "control",
  "lead",
  "title-sm",
  "title-md",
  "title",
  "title-lg",
  "headline",
  "display",
] as const;

export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: [...FONT_SIZES] }] } },
});
