import {
  CONTRASTS,
  DEFAULT_PREFERENCES,
  FONT_SCALES,
  MOTIONS,
  parsePreferences,
  preferenceAttributes,
  type AccessibilityPreferences,
} from "../domain/accessibility.ts";

/** One localStorage record, never sent anywhere. */
export const STORAGE_KEY = "imobiliary_docs_accessibility";

/**
 * Every storage access is wrapped: a private window, cleared site data or a
 * browser set to block storage all throw from the accessor itself, and a
 * preference is never worth a broken page.
 */
export function loadPreferences(): AccessibilityPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_PREFERENCES : parsePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Applies at once, then stores. Reports whether the choice will survive a reload. */
export function savePreferences(preferences: AccessibilityPreferences): boolean {
  applyPreferences(preferences);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

export function applyPreferences(
  preferences: AccessibilityPreferences,
  root: Pick<Element, "setAttribute"> = document.documentElement,
): void {
  for (const [name, value] of Object.entries(preferenceAttributes(preferences))) {
    root.setAttribute(name, value);
  }
}

/**
 * Runs in the page before anything is painted, so a reader who asked for large
 * text never sees small text first.
 *
 * It is serialised with `toString`, so it must stay self-contained: no imports,
 * no closure over module scope. Everything it needs arrives as arguments. It
 * repeats parsePreferences in miniature — the two are tested against the same
 * cases — because shipping the whole module inline would cost more than it
 * saves.
 */
function boot(
  key: string,
  allowed: {
    readonly fontScale: readonly unknown[];
    readonly contrast: readonly unknown[];
    readonly motion: readonly unknown[];
  },
): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (typeof stored !== "object" || stored === null) return;
    const record = stored as Record<string, unknown>;
    const root = document.documentElement;
    for (const field of ["fontScale", "contrast", "motion"] as const) {
      const value = record[field];
      if (allowed[field].includes(value)) {
        const name = field === "fontScale" ? "data-font-scale" : `data-${field}`;
        root.setAttribute(name, String(value));
      }
    }
  } catch {
    // No storage, or a corrupt record: the defaults already on the page stand.
  }
}

/** The inline script, ready for the document head. */
export function bootScript(): string {
  const allowed = { fontScale: FONT_SCALES, contrast: CONTRASTS, motion: MOTIONS };
  return `(${boot.toString()})(${JSON.stringify(STORAGE_KEY)},${JSON.stringify(allowed)});`;
}
