import { accessibilityStorage } from "@imobiliary/ui/accessibility-storage";

/**
 * This platform's one localStorage record, named in its privacy policy.
 *
 * It is built once, here, and imported from here everywhere. Two records under
 * different names on the same page would drift apart, and the document
 * platform keeps its own under a name of its own, on its own origin.
 */
export const STORAGE_KEY = "imobiliary_accessibility";

export const { loadPreferences, savePreferences, applyPreferences, bootScript } =
  accessibilityStorage(STORAGE_KEY);

export {
  SCHEME_BACKGROUNDS,
  SYSTEM_QUERIES,
  systemPreferences,
} from "@imobiliary/ui/accessibility-storage";
