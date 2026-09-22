"use client";
import { useEffect, useRef } from "react";
import type { WallpaperPreferences } from "@/lib/wallpapers";
import { wallpaperUrl } from "@/lib/wallpapers";
import { mediaRect } from "@/lib/wallpaper-contrast";
import { createTextTheme, createWallpaperTextThemes, type WallpaperPaletteResult, type WallpaperTextTheme } from "@/lib/wallpaper-palette";

type Media = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

export function useWallpaperPalette(p: WallpaperPreferences, ready: boolean) {
  const options = useRef(p); options.current = p;
  const refresh = useRef<(() => void) | null>(null);
  const reapply = useRef<(() => void) | null>(null);
  const needsSamples = p.adaptivePalette || (p.adaptiveText && p.textMode !== "fixed");
  useEffect(() => { refresh.current?.(); }, [p.fit, p.positionX, p.positionY, p.brightness]);
  useEffect(() => { reapply.current?.(); }, [p.adaptivePalette, p.adaptiveText, p.textMode, p.textColor]);
  useEffect(() => {
    if (!p.id || !ready) return;
    const id = p.id, root = document.documentElement;
    let stopped = false, failed = false, busy = false, reset = false, lastSample = -Infinity;
    let result: WallpaperPaletteResult | null = null, worker: Worker | null = null;
    let nextSample = 0, resizeTimer = 0, watchdog = 0;
    let fixed: WallpaperTextTheme | null = null;
    const touched = new Set<string>();
    const fallback = { light: createWallpaperTextThemes(0xff808080, 95), dark: createWallpaperTextThemes(0xff808080, 10) };
    const clear = () => {
      delete root.dataset.wallpaperPalette; delete root.dataset.wallpaperText; delete root.dataset.wallpaperTextPolarity;
      for (const name of touched) root.style.removeProperty(name);
      touched.clear();
    };
    const apply = () => {
      if (stopped) return;
      const o = options.current, dark = root.classList.contains("omp") || root.classList.contains("dark");
      const variables = new Map<string, string>();
      let text: WallpaperTextTheme | null = null;
      if (o.adaptiveText) {
        if (o.textMode === "fixed") {
          if (fixed?.color !== o.textColor) fixed = createTextTheme(o.textColor);
          text = fixed;
        } else text = (result?.text ?? fallback[dark ? "dark" : "light"])[o.textMode];
        variables.set("--wallpaper-unified-text", text.color);
        for (const [role, value] of Object.entries(text.surfaces)) variables.set(`--wallpaper-reading-${role}`, value);
        if (root.dataset.wallpaperText !== o.textMode) root.dataset.wallpaperText = o.textMode;
        const polarity = text.darkSurfaces ? "light" : "dark";
        if (root.dataset.wallpaperTextPolarity !== polarity) root.dataset.wallpaperTextPolarity = polarity;
      } else { delete root.dataset.wallpaperText; delete root.dataset.wallpaperTextPolarity; }
      if (o.adaptivePalette && result) {
        for (const [name, value] of Object.entries((text?.darkSurfaces ?? dark) ? result.dark : result.light)) variables.set(`--wallpaper-palette-${name}`, value);
        if (root.dataset.wallpaperPalette !== "on") root.dataset.wallpaperPalette = "on";
      } else delete root.dataset.wallpaperPalette;
      for (const name of touched) if (!variables.has(name)) { root.style.removeProperty(name); touched.delete(name); }
      for (const [name, value] of variables) {
        if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
        touched.add(name);
      }
    };
    reapply.current = apply;
    const theme = new MutationObserver(apply);
    theme.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
    apply();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const fail = () => {
      failed = true; busy = false; result = null;
      clearTimeout(nextSample); clearTimeout(watchdog); worker?.terminate(); apply();
    };
    if (needsSamples && context) {
      try { worker = new Worker(new URL("../lib/wallpaper-palette.worker.ts", import.meta.url)); }
      catch { fail(); }
    }
    // Sandboxed web wallpapers contribute only their local preview, never iframe pixels.
    const preview = needsSamples && p.kind === "web" ? new Image() : null;
    if (preview) { preview.onerror = fail; preview.src = wallpaperUrl(id, true); }
    const schedule = (delay: number) => { clearTimeout(nextSample); nextSample = window.setTimeout(sample, delay); };
    function sample() {
      if (stopped || failed || !worker || !context || busy || document.hidden) return;
      if (!reset && performance.now() - lastSample < 15_000) { schedule(15_000 - (performance.now() - lastSample)); return; }
      const media = preview || document.querySelector<Media>(`.wallpaper-backdrop[data-wallpaper-id="${id}"] > img, .wallpaper-backdrop[data-wallpaper-id="${id}"] > video, .wallpaper-backdrop[data-wallpaper-id="${id}"] > canvas`);
      if (!media) { schedule(1000); return; }
      const width = media instanceof HTMLImageElement ? media.naturalWidth : media instanceof HTMLVideoElement ? media.videoWidth : media.width;
      const height = media instanceof HTMLImageElement ? media.naturalHeight : media instanceof HTMLVideoElement ? media.videoHeight : media.height;
      if (!width || !height) { schedule(1000); return; }
      try {
        const o = options.current, viewport = { width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) };
        const scale = 96 / Math.max(viewport.width, viewport.height);
        canvas.width = Math.max(1, Math.round(viewport.width * scale)); canvas.height = Math.max(1, Math.round(viewport.height * scale));
        const rect = mediaRect({ width, height }, viewport, o.fit, o.positionX, o.positionY);
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(media, rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        busy = true; lastSample = performance.now();
        worker.postMessage({ pixels, reset, brightness: o.brightness }, [pixels.buffer]); reset = false;
        watchdog = window.setTimeout(fail, 10_000);
      } catch { fail(); }
    }
    if (worker) {
      worker.onmessage = (event: MessageEvent<WallpaperPaletteResult | null>) => {
        clearTimeout(watchdog); busy = false;
        if (stopped || failed) return;
        if (event.data) { result = event.data; apply(); }
        schedule(reset ? 500 : 15_000);
      };
      worker.onerror = fail;
    }
    const visibility = () => { if (!document.hidden) sample(); };
    const resize = () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => { reset = true; sample(); }, 500); };
    refresh.current = resize;
    document.addEventListener("visibilitychange", visibility); window.addEventListener("resize", resize);
    sample();
    return () => {
      stopped = true; worker?.terminate(); theme.disconnect();
      clearTimeout(nextSample); clearTimeout(resizeTimer); clearTimeout(watchdog);
      document.removeEventListener("visibilitychange", visibility); window.removeEventListener("resize", resize);
      refresh.current = null; reapply.current = null;
      if (preview) { preview.onerror = null; preview.src = ""; }
      clear();
    };
  }, [p.id, p.kind, ready, needsSamples]);
}
