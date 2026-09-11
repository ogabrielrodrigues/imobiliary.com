import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DEFAULT_PREFERENCES,
  type AccessibilityPreferences,
  type Contrast,
  type FontScale,
  type Motion,
} from "@/domain/accessibility";
import { loadPreferences, savePreferences } from "@/lib/accessibility-storage";
import { cn } from "@/lib/utils";

interface Option<T> {
  readonly value: T;
  readonly label: string;
  readonly description: string;
}

const FONT_OPTIONS: readonly Option<FontScale>[] = [
  { value: 1, label: "Padrão", description: "O tamanho do seu navegador." },
  { value: 1.125, label: "Grande", description: "12,5% maior." },
  { value: 1.25, label: "Maior", description: "25% maior." },
  { value: 1.5, label: "Máximo", description: "50% maior." },
];

const CONTRAST_OPTIONS: readonly Option<Contrast>[] = [
  {
    value: "system",
    label: "Seguir o sistema",
    description: "Alto contraste quando o seu sistema operacional pedir.",
  },
  { value: "standard", label: "Padrão", description: "As cores de sempre." },
  {
    value: "more",
    label: "Alto contraste",
    description: "Fundo preto, texto branco, bordas visíveis e links sublinhados.",
  },
];

const MOTION_OPTIONS: readonly Option<Motion>[] = [
  {
    value: "system",
    label: "Seguir o sistema",
    description: "Reduz as animações quando o seu sistema operacional pedir.",
  },
  {
    value: "reduce",
    label: "Reduzir sempre",
    description: "Sem transições nem animações, em qualquer caso.",
  },
];

/**
 * The accessibility preferences.
 *
 * A change applies the moment it is made and is saved on its own: the page
 * itself is the preview, and a Save button would only be one more thing to
 * find. Native radio groups, because a fieldset and its legend are announced
 * correctly by every screen reader without any help from us.
 */
export function AccessibilityPanel() {
  // Storage does not exist on the server; the stored choice is read once the
  // panel is in the browser. The page is already showing it — the head script
  // applied it before first paint — so only the selected radios catch up.
  const [preferences, setPreferences] = useState<AccessibilityPreferences>(DEFAULT_PREFERENCES);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setPreferences(loadPreferences());
  }, []);

  function update(next: AccessibilityPreferences) {
    setPreferences(next);
    setStatus(
      savePreferences(next)
        ? "Preferência salva neste navegador."
        : "Aplicada, mas este navegador não permite guardá-la: ela vale até você recarregar a página.",
    );
  }

  return (
    <section
      aria-labelledby="accessibility-title"
      className="flex max-w-2xl flex-col gap-5 rounded-lg border border-border bg-card px-5 py-4"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id="accessibility-title" className="text-sm font-semibold">
          Acessibilidade
        </h2>
        <p className="text-small leading-relaxed text-muted-foreground">
          As escolhas valem na hora e ficam guardadas neste navegador, também
          nas páginas fora da sua conta. Em outro dispositivo, ajuste de novo.
        </p>
      </div>

      <RadioGroup
        legend="Tamanho do texto"
        name="fontScale"
        options={FONT_OPTIONS}
        value={preferences.fontScale}
        onChange={(fontScale) => update({ ...preferences, fontScale })}
      />
      <RadioGroup
        legend="Contraste"
        name="contrast"
        options={CONTRAST_OPTIONS}
        value={preferences.contrast}
        onChange={(contrast) => update({ ...preferences, contrast })}
      />
      <RadioGroup
        legend="Animações"
        name="motion"
        options={MOTION_OPTIONS}
        value={preferences.motion}
        onChange={(motion) => update({ ...preferences, motion })}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => update(DEFAULT_PREFERENCES)}
        >
          Restaurar padrões
        </Button>
        {/* Always in the DOM, so a screen reader hears each confirmation. */}
        <p role="status" className="text-caption text-muted-foreground">
          {status}
        </p>
      </div>
    </section>
  );
}

function RadioGroup<T extends string | number>({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly Option<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  const id = useId();

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-small font-medium text-foreground">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => {
          const optionId = `${id}-${String(option.value)}`;
          const checked = option.value === value;
          return (
            <label
              key={String(option.value)}
              htmlFor={optionId}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                checked
                  ? "border-primary bg-primary/10"
                  : "border-input-border hover:bg-row-hover",
              )}
            >
              <input
                id={optionId}
                type="radio"
                name={name}
                checked={checked}
                onChange={() => onChange(option.value)}
                aria-describedby={`${optionId}-description`}
                className="mt-1 size-4 shrink-0 accent-primary"
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
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
