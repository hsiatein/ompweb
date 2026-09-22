export type Ink = "dark" | "light";
export type Rgb = [number, number, number];
export const INK = { dark: [0, 0, 0], light: [253, 253, 253] } satisfies Record<Ink, Rgb>;
export function luminance(rgb: Rgb) {
  const linear = rgb.map(c => { const v = Math.max(0, Math.min(255, c)) / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}
export function contrast(a: Rgb, b: Rgb) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function chooseInk(background: Rgb, previous?: Ink): Ink {
  const dark = contrast(INK.dark, background), light = contrast(INK.light, background);
  // Retain a readable choice to avoid flashing as video crosses the threshold.
  if (previous && (previous === "dark" ? dark : light) >= 4.5) return previous;
  return dark >= light ? "dark" : "light";
}
export function composite(background: Rgb, foreground: number[]): Rgb {
  const alpha = foreground[3] / 255;
  return background.map((c, i) => c * (1 - alpha) + foreground[i] * alpha) as Rgb;
}
export function chooseRegionInk(backgrounds: Rgb[], previous?: Ink): Ink {
  if (!backgrounds.length) return previous ?? "dark";
  const scores = { dark: 0, light: 0 }, readable = { dark: 0, light: 0 };
  for (const background of backgrounds) for (const ink of ["dark", "light"] as const) {
    const ratio = contrast(INK[ink], background);
    // Log contrast balances the whole region instead of letting one bright pixel dominate.
    scores[ink] += Math.log(ratio);
    if (ratio >= 4.5) readable[ink]++;
  }
  const best = scores.dark >= scores.light ? "dark" : "light";
  if (previous && (readable[previous] / backgrounds.length >= .9
    || (scores[best] - scores[previous]) / backgrounds.length < Math.log(1.15))) return previous;
  return best;
}
export function regionSamplePoints(rect: { left: number; top: number; right: number; bottom: number }) {
  const points: { x: number; y: number }[] = [];
  if (rect.right <= rect.left || rect.bottom <= rect.top) return points;
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) points.push({
    x: rect.left + (rect.right - rect.left) * (x + .5) / 6,
    y: rect.top + (rect.bottom - rect.top) * (y + .5) / 6,
  });
  return points;
}
export function mediaRect(source: { width: number; height: number }, viewport: { width: number; height: number }, fit: "cover" | "contain", x: number, y: number) {
  const scale = (fit === "cover" ? Math.max : Math.min)(viewport.width / source.width, viewport.height / source.height);
  const width = source.width * scale, height = source.height * scale;
  return { x: (viewport.width - width) * x / 100, y: (viewport.height - height) * y / 100, width, height };
}
