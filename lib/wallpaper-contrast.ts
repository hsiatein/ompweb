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
export function mediaRect(source: { width: number; height: number }, viewport: { width: number; height: number }, fit: "cover" | "contain", x: number, y: number) {
  const scale = (fit === "cover" ? Math.max : Math.min)(viewport.width / source.width, viewport.height / source.height);
  const width = source.width * scale, height = source.height * scale;
  return { x: (viewport.width - width) * x / 100, y: (viewport.height - height) * y / 100, width, height };
}
