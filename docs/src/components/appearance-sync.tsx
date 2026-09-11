import { useEffect } from "react";

import {
  applyPreferences,
  loadPreferences,
  STORAGE_KEY,
  SYSTEM_QUERIES,
} from "@/lib/accessibility-storage";

/**
 * Keeps the page's appearance current after the first paint.
 *
 * The head script resolves the preferences once, before anything is drawn. Two
 * things can change them afterwards without anyone touching Ajustes on this
 * page: the operating system switching between light and dark, or contrast,
 * or motion; and another tab saving a new preference. Either way the stored
 * choice is resolved again and put back on <html>.
 */
export function AppearanceSync() {
  useEffect(() => {
    const reapply = () => applyPreferences(loadPreferences());
    const lists = Object.values(SYSTEM_QUERIES).map((query) => window.matchMedia(query));
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) reapply();
    };

    for (const list of lists) list.addEventListener("change", reapply);
    window.addEventListener("storage", onStorage);
    return () => {
      for (const list of lists) list.removeEventListener("change", reapply);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return null;
}
