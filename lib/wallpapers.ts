export type GlassMode = "default" | "clear" | "frosted";
export interface WallpaperInfo {
  id: string;
  title: string;
  kind: "image" | "video" | "scene" | "web" | "unsupported";
  source: "imported" | "folder";
  preview: boolean;
  reason?: string;
}
export interface WallpaperPreferences {
  id: string | null;
  kind: "image" | "video" | "scene" | "web";
  glass: GlassMode;
  fit: "cover" | "contain";
  positionX: number;
  positionY: number;
  brightness: number;
  glassOpacity: number;
  paused: boolean;
  adaptiveText: boolean;
  volume: number;
  muted: boolean;
}
export function parseWallpaperPreferences(raw: string | null): WallpaperPreferences {
  let v: Partial<WallpaperPreferences> = {};
  try { v = JSON.parse(raw || "{}") || {}; } catch { /* defaults */ }
  return {
    id: typeof v.id === "string" && /^[a-f0-9]{32}$/.test(v.id) ? v.id : null,
    kind: v.kind === "video" || v.kind === "scene" || v.kind === "web" ? v.kind : "image",
    glass: v.glass === "clear" || v.glass === "frosted" ? v.glass : "default",
    fit: v.fit === "contain" ? "contain" : "cover",
    positionX: typeof v.positionX === "number" && Number.isFinite(v.positionX) ? Math.max(0, Math.min(100, v.positionX)) : 50,
    positionY: typeof v.positionY === "number" && Number.isFinite(v.positionY) ? Math.max(0, Math.min(100, v.positionY)) : 50,
    brightness: typeof v.brightness === "number" && Number.isFinite(v.brightness) ? Math.max(20, Math.min(100, v.brightness)) : 75,
    glassOpacity: typeof v.glassOpacity === "number" && Number.isFinite(v.glassOpacity) ? Math.max(0, Math.min(100, v.glassOpacity)) : 35,
    paused: v.paused === true,
    adaptiveText: v.adaptiveText !== false,
    volume: typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.max(0, Math.min(100, v.volume)) : 50,
    muted: v.muted === true,
  };
}
export function wallpaperUrl(id: string, preview = false) {
  return `/api/wallpapers/${encodeURIComponent(id)}/media${preview ? "?preview=1" : ""}`;
}
