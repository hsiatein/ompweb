import { validBgmId } from "./wallpaper-bgm";
export type GlassMode = "default" | "clear" | "frosted";
export type WallpaperTextMode = "fixed" | "auto" | "material";
export type WallpaperOrientation = "auto" | "all" | "landscape" | "portrait" | "square" | "unknown";
export type WallpaperSort = "added-desc" | "added-asc" | "modified-desc" | "modified-asc" | "name-asc" | "name-desc";
export type WallpaperKindFilter = "all" | WallpaperInfo["kind"];
export interface WallpaperInfo {
  id: string;
  title: string;
  kind: "image" | "video" | "scene" | "web" | "unsupported";
  source: "imported" | "folder";
  preview: boolean;
  reason?: string;
  width?: number;
  height?: number;
  addedAt?: number;
  modifiedAt?: number;
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
  textMode: WallpaperTextMode;
  textColor: string;
  adaptivePalette: boolean;
  volume: number;
  muted: boolean;
  bgmId: string | null;
  libraryOrientation: WallpaperOrientation;
  librarySort: WallpaperSort;
  libraryKind: WallpaperKindFilter;
  sceneForms: Record<string, string>;
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
    textMode: v.textMode === "fixed" || v.textMode === "auto" ? v.textMode : "material",
    textColor: typeof v.textColor === "string" && /^#[0-9a-f]{6}$/i.test(v.textColor) ? v.textColor.toLowerCase() : "#e4e6ed",
    adaptivePalette: v.adaptivePalette === true,
    volume: typeof v.volume === "number" && Number.isFinite(v.volume) ? Math.max(0, Math.min(100, v.volume)) : 50,
    muted: v.muted === true,
    bgmId: validBgmId(v.bgmId) ? v.bgmId : null,
    libraryOrientation: ["all", "landscape", "portrait", "square", "unknown"].includes(v.libraryOrientation || "") ? v.libraryOrientation! : "auto",
    librarySort: ["added-asc", "modified-desc", "modified-asc", "name-asc", "name-desc"].includes(v.librarySort || "") ? v.librarySort! : "added-desc",
    libraryKind: ["image", "video", "scene", "web", "unsupported"].includes(v.libraryKind || "") ? v.libraryKind! : "all",
    sceneForms: v.sceneForms && typeof v.sceneForms === "object" && !Array.isArray(v.sceneForms)
      ? Object.fromEntries(Object.entries(v.sceneForms).filter(([id, form]) => /^[a-f0-9]{32}$/.test(id) && typeof form === "string" && /^[a-f0-9]{16}:(base|xray)$/.test(form)).slice(-256))
      : {},
  };
}
export function wallpaperUrl(id: string, preview = false) {
  return `/api/wallpapers/${encodeURIComponent(id)}/media${preview ? "?preview=1" : ""}`;
}

export function wallpaperOrientation(wallpaper: WallpaperInfo): Exclude<WallpaperOrientation, "auto" | "all"> {
  const { width, height } = wallpaper;
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) return "unknown";
  return width === height ? "square" : width > height ? "landscape" : "portrait";
}

export function selectWallpapers(wallpapers: WallpaperInfo[], options: { query: string; orientation: WallpaperOrientation; kind: WallpaperKindFilter; sort: WallpaperSort; mobile: boolean; locale?: string }) {
  const orientation = options.orientation === "auto" ? (options.mobile ? "portrait" : "landscape") : options.orientation;
  const query = options.query.trim().toLocaleLowerCase(options.locale);
  const collator = new Intl.Collator(options.locale, { numeric: true, sensitivity: "base" });
  const visible = wallpapers.filter(w => (orientation === "all" || wallpaperOrientation(w) === orientation) && (options.kind === "all" || w.kind === options.kind) && w.title.toLocaleLowerCase(options.locale).includes(query));
  const direction = options.sort.endsWith("-desc") ? -1 : 1;
  return visible.sort((a, b) => {
    if (options.sort.startsWith("name-")) return direction * collator.compare(a.title, b.title) || a.id.localeCompare(b.id);
    const av = (options.sort.startsWith("added-") ? a.addedAt : a.modifiedAt) || 0;
    const bv = (options.sort.startsWith("added-") ? b.addedAt : b.modifiedAt) || 0;
    return (!av ? 1 : 0) - (!bv ? 1 : 0) || direction * (av - bv) || collator.compare(a.title, b.title) || a.id.localeCompare(b.id);
  });
}
