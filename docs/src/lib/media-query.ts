import { useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept current as the system setting changes.
 * The server has no system to ask and answers false; the browser corrects it
 * on hydration.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
