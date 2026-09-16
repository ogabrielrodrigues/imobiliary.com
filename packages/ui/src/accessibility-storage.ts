import {
  appearanceAttributes,
  CONTRASTS,
  DEFAULT_PREFERENCES,
  FONT_SCALES,
  MOTIONS,
  parsePreferences,
  resolveAppearance,
  THEMES,
  type AccessibilityPreferences,
  type Scheme,
  type SystemPreferences,
} from "./accessibility.ts";

/**
 * Each platform keeps one localStorage record, under a name of its own, and
 * names it in its privacy policy. They are separate origins, so the records
 * never meet; the name is a parameter so that neither platform has to know
 * about the other's.
 */
export interface AccessibilityStorage {
  readonly storageKey: string;
  loadPreferences(): AccessibilityPreferences;
  savePreferences(preferences: AccessibilityPreferences): boolean;
  applyPreferences(preferences: AccessibilityPreferences, system?: SystemPreferences): void;
  bootScript(): string;
}

/**
 * Each theme's page background, for `<meta name="theme-color">`, which tints
 * the browser's own chrome on mobile. It has to follow the theme, or a light
 * page sits under a black address bar.
 */
export const SCHEME_BACKGROUNDS: Readonly<Record<Scheme, string>> = {
  dark: "#0b0d10",
  light: "#faf9f7",
  paper: "#f2ece1",
};

/** The media queries behind every `system` preference. */
export const SYSTEM_QUERIES = {
  prefersLight: "(prefers-color-scheme: light)",
  prefersMoreContrast: "(prefers-contrast: more)",
  prefersReducedMotion: "(prefers-reduced-motion: reduce)",
} as const;

/** What the system is asking for right now. */
export function systemPreferences(): SystemPreferences {
  const matches = (query: string) => window.matchMedia(query).matches;
  return {
    prefersLight: matches(SYSTEM_QUERIES.prefersLight),
    prefersMoreContrast: matches(SYSTEM_QUERIES.prefersMoreContrast),
    prefersReducedMotion: matches(SYSTEM_QUERIES.prefersReducedMotion),
  };
}

/**
 * Every storage access is wrapped: a private window, cleared site data or a
 * browser set to block storage all throw from the accessor itself, and a
 * preference is never worth a broken page.
 */
function loadPreferences(storageKey: string): AccessibilityPreferences {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw === null ? DEFAULT_PREFERENCES : parsePreferences(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Applies at once, then stores. Reports whether the choice will survive a reload. */
function savePreferences(storageKey: string, preferences: AccessibilityPreferences): boolean {
  applyPreferences(preferences);
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

/** Resolves the preferences against the system and puts the result on the page. */
function applyPreferences(
  preferences: AccessibilityPreferences,
  system: SystemPreferences = systemPreferences(),
): void {
  const appearance = resolveAppearance(preferences, system);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(appearanceAttributes(appearance))) {
    root.setAttribute(name, value);
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", SCHEME_BACKGROUNDS[appearance.scheme]);
}

/**
 * Runs in the page before anything is painted, so a reader who asked for large
 * text or a light theme never sees the default first.
 *
 * It is serialised with `toString`, so it must stay self-contained: no imports,
 * no closure over module scope. Everything it needs arrives as arguments. It
 * repeats parsePreferences and resolveAppearance in miniature — the test runs
 * it against the same cases — because shipping the modules inline would cost
 * more than it saves.
 *
 * It always writes every attribute, stored preference or not: a first visit
 * still has a system that may be asking for high contrast.
 */
function boot(
  key: string,
  allowed: Readonly<Record<"theme" | "fontScale" | "contrast" | "motion", readonly unknown[]>>,
  defaults: Readonly<Record<"theme" | "fontScale" | "contrast" | "motion", unknown>>,
  queries: Readonly<Record<"prefersLight" | "prefersMoreContrast" | "prefersReducedMotion", string>>,
  backgrounds: Readonly<Record<string, string>>,
): void {
  let record: Record<string, unknown> = {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (typeof stored === "object" && stored !== null) {
      record = stored as Record<string, unknown>;
    }
  } catch {
    // No storage, or a corrupt record: the defaults stand.
  }
  const pick = (field: "theme" | "fontScale" | "contrast" | "motion") =>
    allowed[field].includes(record[field]) ? record[field] : defaults[field];
  const matches = (query: string) => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };

  const theme = pick("theme");
  const contrast = pick("contrast");
  const scheme =
    theme === "system" ? (matches(queries.prefersLight) ? "light" : "dark") : String(theme);

  const root = document.documentElement;
  root.setAttribute("data-scheme", scheme);
  root.setAttribute(
    "data-contrast",
    contrast === "system"
      ? matches(queries.prefersMoreContrast)
        ? "more"
        : "standard"
      : String(contrast),
  );
  root.setAttribute(
    "data-motion",
    pick("motion") === "reduce" || matches(queries.prefersReducedMotion)
      ? "reduce"
      : "no-preference",
  );
  root.setAttribute("data-font-scale", String(pick("fontScale")));

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && backgrounds[scheme]) meta.setAttribute("content", backgrounds[scheme]);
}

/** The inline script, ready for the document head. */
function bootScript(storageKey: string): string {
  const allowed = { theme: THEMES, fontScale: FONT_SCALES, contrast: CONTRASTS, motion: MOTIONS };
  const args = [storageKey, allowed, DEFAULT_PREFERENCES, SYSTEM_QUERIES, SCHEME_BACKGROUNDS]
    .map((value) => JSON.stringify(value))
    .join(",");
  return `(${boot.toString()})(${args});`;
}

/**
 * The storage a platform works through. Build it once, in a module of its own,
 * and import that everywhere: two records under different names would drift
 * apart on the same page.
 */
export function accessibilityStorage(storageKey: string): AccessibilityStorage {
  return {
    storageKey,
    loadPreferences: () => loadPreferences(storageKey),
    savePreferences: (preferences) => savePreferences(storageKey, preferences),
    applyPreferences: (preferences, system) => applyPreferences(preferences, system),
    bootScript: () => bootScript(storageKey),
  };
}
