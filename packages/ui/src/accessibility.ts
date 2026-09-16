/**
 * The reader's appearance and accessibility preferences.
 *
 * They are kept in the browser, not on the account: they have to apply before
 * sign-in too, on the landing page and the login form, and they describe a
 * device and its reader as much as a person. What arrives from storage is
 * therefore untrusted — edited by hand, left by an older version, or simply
 * corrupt — and every field is validated on its own, so one bad value costs
 * that one setting and never the page.
 *
 * Several preferences can defer to the operating system. That deferral is
 * resolved here, in one pure function, into concrete values the stylesheet
 * keys on; the stylesheet never has to ask the system itself.
 */

/**
 * The colour themes. Escuro is the product's original look and stays the
 * default; `system` picks Escuro or Claro from `prefers-color-scheme`.
 */
export const THEMES = ["dark", "light", "paper", "system"] as const;
export type Theme = (typeof THEMES)[number];

/** A theme as the page renders it: `system` already decided. */
export type Scheme = Exclude<Theme, "system">;

/** Multipliers of the reader's own browser font size. */
export const FONT_SCALES = [1, 1.125, 1.25, 1.5] as const;
export type FontScale = (typeof FONT_SCALES)[number];

/**
 * `system` follows `prefers-contrast`; `standard` and `more` override it in
 * either direction.
 */
export const CONTRASTS = ["system", "standard", "more"] as const;
export type Contrast = (typeof CONTRASTS)[number];

/**
 * `system` follows `prefers-reduced-motion`. There is deliberately no option
 * to force motion on against the operating system: someone who asked their
 * system to reduce motion may not be the person changing this setting.
 */
export const MOTIONS = ["system", "reduce"] as const;
export type Motion = (typeof MOTIONS)[number];

export interface AccessibilityPreferences {
  readonly theme: Theme;
  readonly fontScale: FontScale;
  readonly contrast: Contrast;
  readonly motion: Motion;
}

export const DEFAULT_PREFERENCES: AccessibilityPreferences = {
  theme: "dark",
  fontScale: 1,
  contrast: "system",
  motion: "system",
};

/** What the operating system is asking for, as far as these preferences care. */
export interface SystemPreferences {
  readonly prefersLight: boolean;
  readonly prefersMoreContrast: boolean;
  readonly prefersReducedMotion: boolean;
}

/** The preferences with every deferral to the system decided. */
export interface ResolvedAppearance {
  readonly scheme: Scheme;
  readonly contrast: "standard" | "more";
  readonly motion: "reduce" | "no-preference";
  readonly fontScale: FontScale;
}

function oneOf<T>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Reads stored preferences, falling back to the default field by field. */
export function parsePreferences(value: unknown): AccessibilityPreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_PREFERENCES;
  const record = value as Record<string, unknown>;
  return {
    theme: oneOf(THEMES, record["theme"], DEFAULT_PREFERENCES.theme),
    fontScale: oneOf(FONT_SCALES, record["fontScale"], DEFAULT_PREFERENCES.fontScale),
    contrast: oneOf(CONTRASTS, record["contrast"], DEFAULT_PREFERENCES.contrast),
    motion: oneOf(MOTIONS, record["motion"], DEFAULT_PREFERENCES.motion),
  };
}

/** Decides every `system` preference against what the system asks for. */
export function resolveAppearance(
  preferences: AccessibilityPreferences,
  system: SystemPreferences,
): ResolvedAppearance {
  return {
    scheme:
      preferences.theme === "system"
        ? system.prefersLight
          ? "light"
          : "dark"
        : preferences.theme,
    contrast:
      preferences.contrast === "system"
        ? system.prefersMoreContrast
          ? "more"
          : "standard"
        : preferences.contrast,
    // Reduce wins from either side; see MOTIONS.
    motion:
      preferences.motion === "reduce" || system.prefersReducedMotion
        ? "reduce"
        : "no-preference",
    fontScale: preferences.fontScale,
  };
}

/**
 * The attributes on `<html>` that the stylesheet keys on. One mapping, used
 * both by the script that runs before first paint and by the settings screen,
 * so the two can never disagree about what an appearance looks like.
 */
export function appearanceAttributes(
  appearance: ResolvedAppearance,
): Readonly<Record<string, string>> {
  return {
    "data-scheme": appearance.scheme,
    "data-contrast": appearance.contrast,
    "data-motion": appearance.motion,
    "data-font-scale": String(appearance.fontScale),
  };
}
