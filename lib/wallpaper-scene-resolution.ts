type Size = { width: number; height: number };

export function sceneOutputSize(source: Size, viewport: Size, dpr: number, fit: string, maxTextureSize: number): Size {
  const width = Math.max(1, source.width), height = Math.max(1, source.height);
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const x = Math.max(1, viewport.width) * ratio / width;
  const y = Math.max(1, viewport.height) * ratio / height;
  const scale = fit === "contain" ? Math.min(x, y) : Math.max(x, y);
  const limit = Math.min(maxTextureSize / width, maxTextureSize / height, Math.sqrt(16_777_216 / (width * height)));
  // Match the displayed physical pixels, including the offscreen part of cover.
  // Source textures and effect buffers retain their original resolution.
  return { width: Math.max(1, Math.floor(width * Math.min(scale, limit))), height: Math.max(1, Math.floor(height * Math.min(scale, limit))) };
}
