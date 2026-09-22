import { createWallpaperPalette, createWallpaperTextThemes, extractWallpaperSeed, selectWallpaperSeed, selectWallpaperTone, wallpaperBackdropTone, type PaletteSelection, type ToneSelection } from "./wallpaper-palette";

let selection: PaletteSelection = { seed: null, pending: null };
let tone: ToneSelection = { tone: null, pending: null };
self.onmessage = (event: MessageEvent<{ pixels: Uint8ClampedArray; reset: boolean; brightness?: number }>) => {
  try {
    if (event.data.reset) { selection = { seed: null, pending: null }; tone = { tone: null, pending: null }; }
    const seed = extractWallpaperSeed(event.data.pixels);
    const backgroundTone = wallpaperBackdropTone(event.data.pixels, event.data.brightness);
    if (seed === null || backgroundTone === null) { self.postMessage(null); return; }
    const next = selectWallpaperSeed(selection, seed);
    const nextTone = selectWallpaperTone(tone, backgroundTone);
    const changed = selection.seed !== next.seed || tone.tone !== nextTone.tone;
    selection = next;
    tone = nextTone;
    self.postMessage(changed ? {
      seed: next.seed,
      light: createWallpaperPalette(next.seed!, false),
      dark: createWallpaperPalette(next.seed!, true),
      text: createWallpaperTextThemes(next.seed!, tone.tone!),
    } : null);
  } catch { self.postMessage(null); }
};
