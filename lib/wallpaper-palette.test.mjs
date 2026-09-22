import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { argbFromHex, Hct, lstarFromArgb, Contrast } from "@material/material-color-utilities";
const jiti = createJiti(import.meta.url);
const { extractWallpaperSeed, createWallpaperPalette, selectWallpaperSeed, similarWallpaperSeeds, createTextTheme, createWallpaperTextThemes, wallpaperBackdropTone, selectWallpaperTone, READING_SURFACES } = await jiti.import("./wallpaper-palette.ts");

const pixels = (...colors) => new Uint8ClampedArray(colors.flatMap(([r, g, b, count = 100, a = 255]) => Array.from({ length: count }, () => [r, g, b, a]).flat()));
const ratio = (a, b) => Contrast.ratioOfTones(lstarFromArgb(argbFromHex(a)), lstarFromArgb(argbFromHex(b)));

test("wallpaper seed ignores transparency and preserves dominant colors", () => {
  assert.equal(extractWallpaperSeed(pixels([255, 0, 0, 100, 0])), null);
  assert.equal(extractWallpaperSeed(new Uint8ClampedArray()), null);
  const seed = extractWallpaperSeed(pixels([34, 129, 161, 1000], [255, 0, 0, 2]));
  assert.ok(similarWallpaperSeeds(seed, argbFromHex("#2281a1")));
});

test("monochrome wallpapers produce neutral palettes, not an unrelated fallback hue", () => {
  for (const level of [0, 80, 160, 255]) {
    const seed = extractWallpaperSeed(pixels([level, level, level]));
    for (const dark of [false, true]) {
      const p = createWallpaperPalette(seed, dark);
      assert.ok(Hct.fromInt(argbFromHex(p.accent)).chroma < 4);
    }
  }
});

test("all hues have restrained chroma and accessible accent roles in both themes", () => {
  for (let hue = 0; hue < 360; hue += 10) {
    const seed = Hct.from(hue, 100, 60).toInt();
    for (const dark of [false, true]) {
      const p = createWallpaperPalette(seed, dark);
      for (const value of Object.values(p)) assert.match(value, /^#[0-9a-f]{6}$/);
      assert.ok(Hct.fromInt(argbFromHex(p.accent)).chroma < 33);
      assert.ok(ratio(p["on-accent"], p["accent-strong"]) >= 4.5);
      assert.ok(ratio(p["on-accent"], p["accent-fill-hover"]) >= 4.5);
      for (const surface of ["bg", "bg-panel", "bg-hover", "bg-selected"]) {
        assert.ok(ratio(p.accent, p[surface]) >= 4.5, `${hue} ${dark} ${surface}`);
        assert.ok(ratio(p["accent-hover"], p[surface]) >= 4.5);
      }
      assert.ok(!Object.keys(p).some(key => key.startsWith("status-") || key.startsWith("text")));
    }
  }
});

test("flashes and minor animation color drift do not change an established palette", () => {
  const blue = Hct.from(240, 32, 50).toInt(), green = Hct.from(150, 32, 50).toInt();
  let state = selectWallpaperSeed({ seed: null, pending: null }, blue);
  assert.equal(state.seed, blue);
  state = selectWallpaperSeed(state, green);
  assert.equal(state.seed, blue);
  state = selectWallpaperSeed(state, blue);
  assert.equal(state.pending, null);
  state = selectWallpaperSeed(state, Hct.from(245, 30, 70).toInt());
  assert.equal(state.seed, blue);
  state = selectWallpaperSeed(selectWallpaperSeed(state, green), green);
  assert.equal(state.seed, green);
});

test("large input sampling remains bounded and deterministic", () => {
  const input = pixels([44, 132, 90, 100_000]);
  assert.equal(extractWallpaperSeed(input), extractWallpaperSeed(input));
});

test("global backdrop tone measures visible linear luminance and brightness", () => {
  assert.equal(wallpaperBackdropTone(new Uint8ClampedArray()), null);
  assert.equal(wallpaperBackdropTone(pixels([255, 255, 255, 10, 0])), null);
  assert.equal(wallpaperBackdropTone(pixels([0, 0, 0])), 0);
  assert.ok(Math.abs(wallpaperBackdropTone(pixels([255, 255, 255])) - 100) < .01);
  const mixed = wallpaperBackdropTone(pixels([0, 0, 0], [255, 255, 255]));
  assert.ok(mixed > 75 && mixed < 77);
  assert.ok(wallpaperBackdropTone(pixels([255, 255, 255]), 20) < 25);
});

test("global text lightness ignores transient flashes and minor brightness drift", () => {
  let state = selectWallpaperTone({ tone: null, pending: null }, 10);
  state = selectWallpaperTone(state, 90);
  assert.equal(state.tone, 10);
  state = selectWallpaperTone(state, 12);
  assert.equal(state.tone, 10);
  assert.equal(state.pending, null);
  state = selectWallpaperTone(selectWallpaperTone(state, 80), 82);
  assert.equal(state.tone, 82);
});

test("fixed text retains its exact color and pairs every solid surface at 4.5:1", () => {
  for (const color of ["#000000", "#FFFFFF", "#757575", "#808080", "#ff0000", "#00ff00", "#0000ff", "#c7c4dc"]) {
    const theme = createTextTheme(color);
    assert.equal(theme.color, color.toLowerCase());
    for (const role of READING_SURFACES) assert.ok(ratio(theme.color, theme.surfaces[role]) >= 4.5, `${color} ${role}`);
  }
});

test("automatic text is monochrome; Material text uses low chroma and Google's contrast selection", () => {
  for (let hue = 0; hue < 360; hue += 30) {
    for (let tone = 0; tone <= 100; tone += 5) {
      const themes = createWallpaperTextThemes(Hct.from(hue, 60, 55).toInt(), tone);
      const best = Math.max(Contrast.ratioOfTones(tone, 0), Contrast.ratioOfTones(tone, 100));
      assert.ok(["#000000", "#ffffff"].includes(themes.auto.color));
      assert.ok(Math.abs(Contrast.ratioOfTones(tone, lstarFromArgb(argbFromHex(themes.auto.color))) - best) < .01);
      assert.ok(Hct.fromInt(argbFromHex(themes.material.color)).chroma < 8);
      assert.ok(Contrast.ratioOfTones(tone, lstarFromArgb(argbFromHex(themes.material.color))) >= Math.min(7, best) - .15);
      for (const theme of Object.values(themes)) {
        for (const role of READING_SURFACES) assert.ok(ratio(theme.color, theme.surfaces[role]) >= 4.5);
      }
    }
  }
});
