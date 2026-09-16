import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Holds every theme to WCAG contrast.
 *
 * It reads the stylesheet itself rather than a copy of its values, so a colour
 * changed in tokens.css is checked as it is shipped. Only the two notations the
 * palettes use are understood, hex and oklch; a token written any other way
 * fails loudly instead of passing unchecked.
 */

type Rgb = readonly [number, number, number];

// Line endings are normalised: with core.autocrlf a checkout writes CRLF, and
// the selectors below are matched across a line break.
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replaceAll("\r\n", "\n");

/**
 * The custom properties declared in the first block whose selector is exactly
 * `selector`. Declarations hold no braces, so the block ends at the first
 * closing one.
 */
function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `no ${selector} block in tokens.css`);
  const body = css.slice(start, css.indexOf("}", start));
  const map = new Map<string, string>();
  for (const match of body.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
    map.set(match[1]!, match[2]!.trim());
  }
  return map;
}

/**
 * Blocks layered the way the cascade layers them on <html>: later blocks
 * override earlier ones, and a token a block leaves out falls through to the
 * one below — so it is checked with the value the page would really use.
 */
function layered(...selectors: string[]): Map<string, string> {
  return new Map(selectors.flatMap((selector) => [...tokens(selector)]));
}

function parse(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = hex[1]!;
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as unknown as Rgb;
  }
  const ok = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (ok) return oklchToRgb(Number(ok[1]), Number(ok[2]), Number(ok[3]));
  throw new Error(`cannot check a colour written as ${value}`);
}

/** OKLCH to sRGB, clipped to the gamut as a browser would render it. */
function oklchToRgb(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l1 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m1 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s1 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1,
    -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1,
    -0.0041960863 * l1 - 0.7034186147 * m1 + 1.707614701 * s1,
  ];
  return linear.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  }) as unknown as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A colour at `alpha` over a ground — how a /15 tint actually renders. */
function over(color: Rgb, ground: Rgb, alpha: number): Rgb {
  return color.map((v, i) => v * alpha + ground[i]! * (1 - alpha)) as unknown as Rgb;
}

/** The checks one palette must pass, at the text ratio it is held to. */
function assertPalette(palette: Map<string, string>, textRatio: number) {
  const color = (name: string) => {
    const value = palette.get(name);
    assert.ok(value, `--${name} is not declared`);
    return parse(value);
  };
  const grounds = { background: color("background"), card: color("card") };
  const failures: string[] = [];
  const check = (label: string, got: number, want: number) => {
    if (got < want) failures.push(`${label}: ${got.toFixed(2)}:1, needs ${want}:1`);
  };

  // Everything that is set as text, on the page and on a card.
  const texts = [
    "foreground", "muted-foreground", "faint",
    "primary-text", "destructive", "success", "docs",
    "docs-soft", "success-soft", "destructive-soft",
  ];
  for (const text of texts) {
    for (const [ground, value] of Object.entries(grounds)) {
      check(`--${text} on --${ground}`, ratio(color(text), value), textRatio);
    }
  }
  // Text set on an accent's own tint, up to 15%: pills, banners, chips, the
  // destructive button.
  const onTint = [
    ["primary-text", "primary"],
    ["docs-soft", "docs"],
    ["success-soft", "success"],
    ["destructive-soft", "destructive"],
  ] as const;
  for (const [text, accent] of onTint) {
    for (const [ground, value] of Object.entries(grounds)) {
      const tint = over(color(accent), value, 0.15);
      check(`--${text} on the 15% --${accent} tint over --${ground}`, ratio(color(text), tint), textRatio);
    }
  }
  check("--primary-foreground on --primary", ratio(color("primary-foreground"), color("primary")), textRatio);
  // Non-text: a field's edge and the focus ring, 1.4.11.
  for (const [ground, value] of Object.entries(grounds)) {
    check(`--input-border on --${ground}`, ratio(color("input-border"), value), 3);
    check(`--input-border on --input`, ratio(color("input-border"), color("input")), 3);
    check(`--ring on --${ground}`, ratio(color("ring"), value), 3);
  }

  assert.deepEqual(failures, []);
}

const DARK = ':root,\n[data-scheme="dark"]';
const LIGHT = '[data-scheme="light"]';
const PAPER = '[data-scheme="paper"]';
const HIGH_CONTRAST = ':root[data-contrast="more"]';
const HIGH_CONTRAST_LIGHT =
  ':root[data-contrast="more"]:is([data-scheme="light"], [data-scheme="paper"])';

describe("palette contrast", () => {
  it("passes WCAG AA in Escuro", () => {
    assertPalette(layered(DARK), 4.5);
  });

  it("passes WCAG AA in Claro", () => {
    assertPalette(layered(DARK, LIGHT), 4.5);
  });

  it("passes WCAG AA in Papel", () => {
    assertPalette(layered(DARK, PAPER), 4.5);
  });

  it("passes WCAG AAA in dark high contrast", () => {
    assertPalette(layered(DARK, HIGH_CONTRAST), 7);
  });

  it("passes WCAG AAA in light high contrast, from both light themes", () => {
    assertPalette(layered(DARK, LIGHT, HIGH_CONTRAST, HIGH_CONTRAST_LIGHT), 7);
    assertPalette(layered(DARK, PAPER, HIGH_CONTRAST, HIGH_CONTRAST_LIGHT), 7);
  });
});
