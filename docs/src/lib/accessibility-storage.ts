import { accessibilityStorage } from "@imobiliary/ui/accessibility-storage";

/**
 * This platform's one localStorage record, named in its privacy policy.
 *
 * It is built once, here, and imported from here everywhere. The rental
 * platform keeps its own record under another name, on its own origin; the
 * two never meet. Changing this name would silently drop every reader's saved
 * preferences.
 */
export const STORAGE_KEY = "imobiliary_docs_accessibility";

export const { loadPreferences, savePreferences, applyPreferences, bootScript } =
  accessibilityStorage(STORAGE_KEY);

export {
  SCHEME_BACKGROUNDS,
  SYSTEM_QUERIES,
  systemPreferences,
} from "@imobiliary/ui/accessibility-storage";
