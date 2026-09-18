"use client";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { parseWallpaperPreferences, type WallpaperPreferences } from "@/lib/wallpapers";
const KEY = "omp-web:wallpaper";
const EVENT = "omp-web:wallpaper-preferences";
function snapshot() { try { return localStorage.getItem(KEY); } catch { return null; } }
function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", listener); };
}
export function useWallpaperPreferences() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => null);
  const preferences = useMemo(() => parseWallpaperPreferences(raw), [raw]);
  const update = useCallback((patch: Partial<WallpaperPreferences>) => {
    const previous = parseWallpaperPreferences(snapshot());
    const resetPosition = patch.id && patch.id !== previous.id ? { positionX: 50, positionY: 50 } : {};
    const next = parseWallpaperPreferences(JSON.stringify({ ...previous, ...resetPosition, ...patch }));
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { preferences, update };
}
