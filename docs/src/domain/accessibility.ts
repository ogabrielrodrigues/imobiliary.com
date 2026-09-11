/**
 * The reader's accessibility preferences.
 *
 * They are kept in the browser, not on the account: they have to apply before
 * sign-in too, on the landing page and the login form, and they describe a
 * device and its reader as much as a person. What arrives from storage is
 * therefore untrusted — edited by hand, left by an older version, or simply
 * corrupt — and every field is validated on its own, so one bad value costs
 * that one setting and never the page.
 */

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
  readonly fontScale: FontScale;
  readonly contrast: Contrast;
  readonly motion: Motion;
}

export const DEFAULT_PREFERENCES: AccessibilityPreferences = {
  fontScale: 1,
  contrast: "system",
  motion: "system",
};

function oneOf<T>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Reads stored preferences, falling back to the default field by field. */
export function parsePreferences(value: unknown): AccessibilityPreferences {
  if (typeof value !== "object" || value === null) return DEFAULT_PREFERENCES;
  const record = value as Record<string, unknown>;
  return {
    fontScale: oneOf(FONT_SCALES, record["fontScale"], DEFAULT_PREFERENCES.fontScale),
    contrast: oneOf(CONTRASTS, record["contrast"], DEFAULT_PREFERENCES.contrast),
    motion: oneOf(MOTIONS, record["motion"], DEFAULT_PREFERENCES.motion),
  };
}

/**
 * The attributes on `<html>` that the stylesheet keys on. One mapping, used
 * both by the script that runs before first paint and by the settings screen,
 * so the two can never disagree about what a preference looks like.
 */
export function preferenceAttributes(
  preferences: AccessibilityPreferences,
): Readonly<Record<string, string>> {
  return {
    "data-font-scale": String(preferences.fontScale),
    "data-contrast": preferences.contrast,
    "data-motion": preferences.motion,
  };
}
