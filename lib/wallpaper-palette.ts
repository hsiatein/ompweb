import { argbFromHex, argbFromRgb, Contrast, DynamicColor, Hct, hexFromArgb, lstarFromArgb, lstarFromY, QuantizerCelebi, Score, TonalPalette } from "@material/material-color-utilities";
import { luminance } from "./wallpaper-contrast";

export type WallpaperPalette = Record<string, string>;
export type WallpaperTextTheme = { color: string; darkSurfaces: boolean; surfaces: WallpaperPalette };
export type WallpaperPaletteResult = { seed: number; light: WallpaperPalette; dark: WallpaperPalette; text: { auto: WallpaperTextTheme; material: WallpaperTextTheme } };
export type PaletteSelection = { seed: number | null; pending: number | null };
export type ToneSelection = { tone: number | null; pending: number | null };
export const READING_SURFACES = ["bg", "bg-panel", "bg-hover", "bg-selected", "bg-subtle", "user-bg", "tool-bg"] as const;

export function wallpaperBackdropTone(pixels: Uint8ClampedArray, brightness = 100): number | null {
  let total = 0, count = 0;
  const scale = Math.max(.2, Math.min(1, brightness / 100));
  const stride = Math.max(1, Math.ceil(pixels.length / 4 / 9216));
  for (let i = 0; i + 3 < pixels.length; i += stride * 4) {
    if (pixels[i + 3] < 192) continue;
    total += luminance([pixels[i] * scale, pixels[i + 1] * scale, pixels[i + 2] * scale]); count++;
  }
  return count ? lstarFromY(total / count * 100) : null;
}

export function selectWallpaperTone(state: ToneSelection, candidate: number): ToneSelection {
  if (state.tone === null) return { tone: candidate, pending: null };
  if (Math.abs(state.tone - candidate) < 5) return { tone: state.tone, pending: null };
  if (state.pending !== null && Math.abs(state.pending - candidate) < 5) return { tone: candidate, pending: null };
  return { tone: state.tone, pending: candidate };
}

export function createTextTheme(color: string, seed = argbFromHex(color)): WallpaperTextTheme {
  const textTone = lstarFromArgb(argbFromHex(color));
  const darkSurfaces = Contrast.ratioOfTones(textTone, 0) >= Contrast.ratioOfTones(textTone, 100);
  const palette = createWallpaperPalette(seed, darkSurfaces);
  const surfaces: WallpaperPalette = { border: palette.border };
  for (const role of READING_SURFACES) {
    const hct = Hct.fromInt(argbFromHex(palette[role]));
    let tone = hct.tone, value = palette[role];
    // Match solid panels to the chosen ink, including mid-tone custom colors.
    while (Contrast.ratioOfTones(textTone, lstarFromArgb(argbFromHex(value))) < 4.5 && tone > 0 && tone < 100) {
      tone = Math.max(0, Math.min(100, tone + (darkSurfaces ? -1 : 1)));
      value = hexFromArgb(Hct.from(hct.hue, hct.chroma, tone).toInt());
    }
    surfaces[role] = value;
  }
  return { color: color.toLowerCase(), darkSurfaces, surfaces };
}

export function createWallpaperTextThemes(seed: number, backgroundTone: number): WallpaperPaletteResult["text"] {
  const source = Hct.fromInt(seed);
  const autoColor = Contrast.ratioOfTones(backgroundTone, 0) >= Contrast.ratioOfTones(backgroundTone, 100) ? "#000000" : "#ffffff";
  // Google's foreground tone targets 7:1 against the wallpaper's overall lightness.
  const tone = DynamicColor.foregroundTone(backgroundTone, 7);
  const materialColor = hexFromArgb(Hct.from(source.hue, source.chroma < 8 ? 0 : 6, tone).toInt());
  return { auto: createTextTheme(autoColor, seed), material: createTextTheme(materialColor, seed) };
}

export function extractWallpaperSeed(rgba: Uint8ClampedArray): number | null {
  const pixels: number[] = [];
  const stride = Math.max(1, Math.ceil(rgba.length / 4 / 9216));
  for (let i = 0; i + 3 < rgba.length; i += stride * 4) {
    if (rgba[i + 3] >= 192) pixels.push(argbFromRgb(rgba[i], rgba[i + 1], rgba[i + 2]));
  }
  if (!pixels.length) return null;
  const populations = QuantizerCelebi.quantize(pixels, 32);
  // Grayscale wallpapers must not fall back to Google's unrelated blue seed.
  const dominant = [...populations].sort((a, b) => b[1] - a[1])[0][0];
  const total = pixels.length;
  const substantial = new Map([...populations].filter(([, count]) => count / total >= 0.01));
  return Score.score(substantial, { desired: 1, fallbackColorARGB: dominant })[0];
}

export function createWallpaperPalette(seed: number, dark: boolean): WallpaperPalette {
  const color = Hct.fromInt(seed);
  const chroma = color.chroma < 8 ? 0 : Math.min(32, color.chroma);
  const accent = TonalPalette.fromHueAndChroma(color.hue, chroma);
  const neutral = TonalPalette.fromHueAndChroma(color.hue, Math.min(4, chroma));
  const surface = TonalPalette.fromHueAndChroma(color.hue, Math.min(10, chroma));
  const tone = (palette: TonalPalette, value: number) => hexFromArgb(palette.tone(value));
  return {
    accent: tone(accent, dark ? 80 : 32),
    "accent-strong": tone(accent, 40),
    "accent-hover": tone(accent, dark ? 88 : 26),
    "accent-fill-hover": tone(accent, 32),
    "accent-2": tone(accent, dark ? 85 : 36),
    "on-accent": "#ffffff",
    bg: tone(neutral, dark ? 6 : 98),
    "bg-panel": tone(neutral, dark ? 10 : 97),
    "bg-hover": tone(surface, dark ? 14 : 95),
    "bg-selected": tone(surface, dark ? 18 : 93),
    "bg-subtle": tone(neutral, dark ? 8 : 96),
    border: tone(surface, dark ? 30 : 80),
    "user-bg": tone(surface, dark ? 12 : 96),
    "tool-bg": tone(neutral, dark ? 10 : 97),
  };
}

export function similarWallpaperSeeds(a: number, b: number): boolean {
  const x = Hct.fromInt(a), y = Hct.fromInt(b);
  if (x.chroma < 8 && y.chroma < 8) return true;
  const hue = Math.abs(x.hue - y.hue);
  return Math.min(hue, 360 - hue) < 18 && Math.abs(Math.min(32, x.chroma) - Math.min(32, y.chroma)) < 10;
}

// A new hue must survive two spaced samples; ignore flashes and tiny color drift.
export function selectWallpaperSeed(state: PaletteSelection, candidate: number): PaletteSelection {
  if (state.seed === null) return { seed: candidate, pending: null };
  if (similarWallpaperSeeds(state.seed, candidate)) return { seed: state.seed, pending: null };
  if (state.pending !== null && similarWallpaperSeeds(state.pending, candidate)) return { seed: candidate, pending: null };
  return { seed: state.seed, pending: candidate };
}
