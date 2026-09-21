import { IconRefresh } from "@tabler/icons-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_PREFERENCES,
  type AccessibilityPreferences,
  type Contrast,
  type FontScale,
  type Motion,
} from "@imobiliary/ui/accessibility";
import { loadPreferences, savePreferences, SYSTEM_QUERIES } from "@/lib/accessibility-storage";
import { useMediaQuery } from "@/lib/media-query";

/** The slider's steps, in order. The scale is ordinal, which is what makes a slider fit. */
const FONT_STEPS: readonly { readonly value: FontScale; readonly label: string; readonly percent: string }[] = [
  { value: 1, label: "Padrão", percent: "100%" },
  { value: 1.125, label: "Grande", percent: "112,5%" },
  { value: 1.25, label: "Maior", percent: "125%" },
  { value: 1.5, label: "Máximo", percent: "150%" },
];

/**
 * The accessibility preferences.
 *
 * A change applies the moment it is made and is saved on its own: the page
 * itself is the preview, and a Save button would only be one more thing to
 * find. Text size is a scale, so it is a slider; contrast and motion are on or
 * off, so they are switches.
 */
export function AccessibilityPanel() {
  // Storage does not exist on the server; the stored choice is read once the
  // panel is in the browser. The page is already showing it — the head script
  // applied it before first paint — so only the controls catch up.
  const [preferences, setPreferences] = useState<AccessibilityPreferences>(DEFAULT_PREFERENCES);
  const [status, setStatus] = useState("");
  const systemWantsContrast = useMediaQuery(SYSTEM_QUERIES.prefersMoreContrast);
  const systemReducesMotion = useMediaQuery(SYSTEM_QUERIES.prefersReducedMotion);

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
      className="flex max-w-2xl flex-col gap-6 rounded-lg border border-border bg-card px-5 py-4"
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

      <FontSizeSlider
        value={preferences.fontScale}
        onCommit={(fontScale) => update({ ...preferences, fontScale })}
      />

      <ContrastControl
        value={preferences.contrast}
        systemWantsMore={systemWantsContrast}
        onChange={(contrast) => update({ ...preferences, contrast })}
      />

      <MotionControl
        value={preferences.motion}
        systemReduces={systemReducesMotion}
        onChange={(motion) => update({ ...preferences, motion })}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          // The theme lives in Aparência and is not an accessibility setting,
          // so restoring these defaults leaves it as it is.
          onClick={() => update({ ...DEFAULT_PREFERENCES, theme: preferences.theme })}
        >
          <IconRefresh data-icon="inline-start" aria-hidden="true" />
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

/**
 * Text size as a four-step slider.
 *
 * The step's name follows the thumb while it moves, but the size is applied
 * only when it is released: resizing the whole page mid-drag would move the
 * slider out from under the pointer. With the keyboard every arrow press is a
 * release, so each step applies at once.
 */
function FontSizeSlider({
  value,
  onCommit,
}: {
  readonly value: FontScale;
  readonly onCommit: (value: FontScale) => void;
}) {
  const committed = Math.max(0, FONT_STEPS.findIndex((step) => step.value === value));
  const [pending, setPending] = useState<number | null>(null);
  const index = pending ?? committed;
  const current = FONT_STEPS[index] ?? FONT_STEPS[0]!;

  const stepAt = (next: number | readonly number[]) =>
    Array.isArray(next) ? (next[0] ?? 0) : (next as number);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-small font-medium text-foreground">Tamanho do texto</span>
        {/* The thumb announces this itself, so it is hidden from screen readers. */}
        <span aria-hidden="true" className="text-caption text-muted-foreground tabular-nums">
          {current.label} · {current.percent}
        </span>
      </div>

      <Slider
        min={0}
        max={FONT_STEPS.length - 1}
        step={1}
        value={[index]}
        onValueChange={(next) => setPending(stepAt(next))}
        onValueCommitted={(next) => {
          setPending(null);
          const step = FONT_STEPS[stepAt(next)];
          if (step) onCommit(step.value);
        }}
        thumbProps={{
          getAriaLabel: () => "Tamanho do texto",
          getAriaValueText: (_formatted, raw) => {
            const step = FONT_STEPS[raw];
            return step ? `${step.label}, ${step.percent}` : String(raw);
          },
        }}
        className="py-2"
      />

      <div aria-hidden="true" className="flex justify-between text-label text-faint">
        {FONT_STEPS.map((step) => (
          <span key={step.value}>{step.label}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * High contrast: a switch, and whether to leave the decision to the system.
 *
 * Three stored states behind two controls. While the system decides, the switch
 * is disabled and shows what the system is asking for right now, so the reader
 * sees the effect they are getting and not an unexplained "off".
 */
function ContrastControl({
  value,
  systemWantsMore,
  onChange,
}: {
  readonly value: Contrast;
  readonly systemWantsMore: boolean;
  readonly onChange: (value: Contrast) => void;
}) {
  const followsSystem = value === "system";
  const on = followsSystem ? systemWantsMore : value === "more";

  return (
    <div className="flex flex-col gap-2.5">
      <SwitchRow
        label="Alto contraste"
        description="Fundo preto, texto branco, bordas visíveis e links sublinhados."
        checked={on}
        disabled={followsSystem}
        onCheckedChange={(checked) => onChange(checked ? "more" : "standard")}
      />
      <label className="flex cursor-pointer items-center gap-2 text-caption text-muted-foreground">
        <input
          type="checkbox"
          checked={followsSystem}
          onChange={(event) => {
            // Read before any state update: React clears the event afterwards.
            const checked = event.currentTarget.checked;
            // Leaving the system's hands keeps what it was showing, so the
            // page does not change under the reader at the moment they choose.
            onChange(checked ? "system" : systemWantsMore ? "more" : "standard");
          }}
          className="size-4 shrink-0 accent-primary"
        />
        Seguir o sistema operacional
        {followsSystem && (
          <span className="text-faint">
            (agora {systemWantsMore ? "pedindo alto contraste" : "sem pedido de alto contraste"})
          </span>
        )}
      </label>
    </div>
  );
}

/**
 * Reduced motion, as one switch. Off still honours the system: there is no
 * setting that forces motion back on against it.
 */
function MotionControl({
  value,
  systemReduces,
  onChange,
}: {
  readonly value: Motion;
  readonly systemReduces: boolean;
  readonly onChange: (value: Motion) => void;
}) {
  return (
    <SwitchRow
      label="Reduzir animações sempre"
      description={
        systemReduces
          ? "Seu sistema operacional já pede menos movimento, e isso é respeitado mesmo com esta opção desligada."
          : "Sem transições nem animações. Desligada, seguimos o que o seu sistema operacional pedir."
      }
      checked={value === "reduce"}
      onCheckedChange={(checked) => onChange(checked ? "reduce" : "system")}
    />
  );
}

/** A labelled switch with a description, the whole row clickable. */
function SwitchRow({
  label,
  description,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  readonly label: ReactNode;
  readonly description: ReactNode;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();

  return (
    <label
      className={
        disabled
          ? "flex items-start justify-between gap-4"
          : "flex cursor-pointer items-start justify-between gap-4"
      }
    >
      <span className="flex flex-col gap-0.5">
        <span id={`${id}-label`} className="text-small font-medium text-foreground">
          {label}
        </span>
        <span id={`${id}-description`} className="text-caption text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next)}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="mt-0.5"
      />
    </label>
  );
}
