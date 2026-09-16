# @imobiliary/ui

What both platforms must agree on: the design tokens and the three themes, the
type scale, the reader's accessibility preferences, the self-hosted fonts, and
the class merger that knows the scale.

Components are not here. shadcn's model is to copy a component into the app
that uses it and edit it there, and the two platforms do diverge in their
components; what may not diverge is a colour, a size or the meaning of a
preference.

| Export | What |
|---|---|
| `@imobiliary/ui/tokens.css` | Themes, type scale, base layer, preferences, fonts |
| `@imobiliary/ui/accessibility` | The preferences, their parsing and their resolution against the system |
| `@imobiliary/ui/accessibility-storage` | Reading, saving and applying them in a browser, plus the head script |
| `@imobiliary/ui/cn` | `cn`, told about the type scale, and `FONT_SIZES` |

## Using the stylesheet

Tailwind stays in the app's own stylesheet: that is where its source detection
starts, and importing it here would have it scan this package instead of the
app.

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "@imobiliary/ui/tokens.css";
```

Rules that belong to one screen or one component stay in the app.

## Using the preferences

Each platform keeps one `localStorage` record, under a name of its own, and
names that record in its privacy policy. Build the storage once and import
that module everywhere:

```ts
import { accessibilityStorage } from "@imobiliary/ui/accessibility-storage";

export const { loadPreferences, savePreferences, applyPreferences, bootScript } =
  accessibilityStorage("imobiliary_accessibility");
```

`bootScript()` is the inline script for the document head: it resolves every
"follow the system" choice and writes `data-scheme`, `data-contrast`,
`data-motion` and `data-font-scale` on `<html>` before the first paint, so a
reader who asked for large text or a light theme never sees the default first.
After hydration the app re-applies them on a media-query change or a `storage`
event from another tab.

## Checks

```sh
pnpm --filter ./packages/ui check
```

The tests run on Node's own runner over the TypeScript directly. Two of them
read `tokens.css` as it ships: `contrast.test.ts` holds all five palettes to
WCAG contrast, and `cn.test.ts` fails when a size is added to the scale without
being declared to the class merger, which used to drop it silently.
