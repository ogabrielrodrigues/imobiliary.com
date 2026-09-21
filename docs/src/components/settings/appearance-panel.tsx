import { useEffect, useId, useState } from "react";

import {
  DEFAULT_PREFERENCES,
  type AccessibilityPreferences,
  type Scheme,
  type Theme,
} from "@imobiliary/ui/accessibility";
import {
  loadPreferences,
  savePreferences,
  SYSTEM_QUERIES,
} from "@/lib/accessibility-storage";
import { useMediaQuery } from "@/lib/media-query";
import { cn } from "@/lib/utils";

interface ThemeOption {
  readonly value: Theme;
  readonly label: string;
  readonly description: string;
}

const OPTIONS: readonly ThemeOption[] = [
  { value: "dark", label: "Escuro", description: "O padrão: grafite com destaques em âmbar." },
  { value: "light", label: "Claro", description: "Fundo claro e neutro, para ambientes iluminados." },
  { value: "paper", label: "Papel", description: "Claro em tons de papel, sem branco puro." },
  {
    value: "system",
    label: "Seguir o sistema",
    description: "Escuro ou Claro, conforme o seu sistema operacional.",
  },
];

/**
 * The colour theme.
 *
 * Like the accessibility panel, a choice applies at once and saves itself. The
 * previews are the real themes, not pictures of them: each is a small block
 * carrying data-scheme, which the stylesheet honours on any element.
 */
export function AppearancePanel() {
  // Read once in the browser; the page itself already shows the stored theme,
  // applied by the head script before first paint.
  const [preferences, setPreferences] = useState<AccessibilityPreferences>(DEFAULT_PREFERENCES);
  const [status, setStatus] = useState("");
  const systemLight = useMediaQuery(SYSTEM_QUERIES.prefersLight);
  const id = useId();

  useEffect(() => {
    setPreferences(loadPreferences());
  }, []);

  function choose(theme: Theme) {
    const next = { ...preferences, theme };
    setPreferences(next);
    setStatus(
      savePreferences(next)
        ? "Tema salvo neste navegador."
        : "Aplicado, mas este navegador não permite guardá-lo: ele vale até você recarregar a página.",
    );
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex max-w-2xl flex-col gap-5 rounded-lg border border-border bg-card px-5 py-4"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id={`${id}-title`} className="text-sm font-semibold">
          Tema
        </h2>
        <p className="text-small leading-relaxed text-muted-foreground">
          Vale na hora e fica guardado neste navegador, também nas páginas fora
          da sua conta. Com o alto contraste ligado, os temas claros ficam em
          branco e preto.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Tema</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map((option) => {
            const optionId = `${id}-${option.value}`;
            const checked = option.value === preferences.theme;
            return (
              <label
                key={option.value}
                htmlFor={optionId}
                className={cn(
                  "flex cursor-pointer flex-col gap-3 rounded-lg border p-3 transition-colors",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                  checked
                    ? "border-primary-text bg-primary/10"
                    : "border-input-border hover:bg-row-hover",
                )}
              >
                {option.value === "system" ? (
                  <div className="grid grid-cols-2 gap-1.5">
                    <ThemePreview scheme="dark" />
                    <ThemePreview scheme="light" />
                  </div>
                ) : (
                  <ThemePreview scheme={option.value} />
                )}
                <span className="flex items-start gap-2.5">
                  <input
                    id={optionId}
                    type="radio"
                    name={`${id}-theme`}
                    checked={checked}
                    onChange={() => choose(option.value)}
                    aria-describedby={`${optionId}-description`}
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-small font-medium text-foreground">
                      {option.label}
                    </span>
                    <span
                      id={`${optionId}-description`}
                      className="text-caption text-muted-foreground"
                    >
                      {option.description}
                      {option.value === "system" &&
                        ` Agora: ${systemLight ? "Claro" : "Escuro"}.`}
                    </span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Always in the DOM, so a screen reader hears each confirmation. */}
      <p role="status" className="text-caption text-muted-foreground">
        {status}
      </p>
    </section>
  );
}

/**
 * A miniature of a theme: sidebar, two lines of text and a primary button,
 * drawn with that theme's own tokens. Decorative; the label names the theme.
 */
function ThemePreview({ scheme }: { readonly scheme: Scheme }) {
  return (
    <div
      data-scheme={scheme}
      aria-hidden="true"
      className="flex h-16 overflow-hidden rounded-md border border-border bg-background"
    >
      <div className="w-1/4 border-r border-border bg-raised" />
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <div className="h-1.5 w-3/4 rounded-full bg-foreground/70" />
        <div className="h-1.5 w-1/2 rounded-full bg-muted-foreground/50" />
        <div className="mt-auto h-3 w-8 rounded-sm bg-primary" />
      </div>
    </div>
  );
}
