"use client";
import { useEffect } from "react";
import { chooseInk, composite, mediaRect, type Ink, type Rgb } from "@/lib/wallpaper-contrast";
import type { WallpaperPreferences } from "@/lib/wallpapers";

const ROOTS = ".wallpaper-shell, .wallpaper-panel-toggle";
const SKIP = 'pre, code, svg, input, textarea, select, option, [contenteditable="true"], [role="alert"], [style*="--status-"], [data-wallpaper-contrast="off"], .file-diff-view, .wallpaper-thumbnail, mark';
type Run = { range: Range; rect: DOMRect; fills: number[][]; ink?: Ink };
type Control = { element: HTMLElement; x: number; y: number; fills: number[][]; ink?: Ink };
const visible = (r: DOMRect) => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;

export function useWallpaperContrast(p: WallpaperPreferences, ready: boolean) {
  useEffect(() => {
    if (!p.adaptiveText || !p.id || !ready || p.kind === "web" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
    const surface = document.createElement("canvas"); surface.width = 320;
    const ctx = surface.getContext("2d", { willReadFrequently: true });
    const colorCanvas = document.createElement("canvas"); colorCanvas.width = colorCanvas.height = 1;
    const colors = colorCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx || !colors) return;
    const colorCache = new Map<string, number[]>();
    const rgba = (value: string) => {
      if (!colorCache.has(value)) {
        colors.clearRect(0, 0, 1, 1); colors.fillStyle = value; colors.fillRect(0, 0, 1, 1);
        colorCache.set(value, Array.from(colors.getImageData(0, 0, 1, 1).data));
      }
      return colorCache.get(value)!;
    };
    let runs: Run[] = [], controls: Control[] = [], dirty = true, stopped = false;
    const touched = new Set<HTMLElement>();
    const words = new Intl.Segmenter(undefined, { granularity: "word" });
    const glyphs = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const rebuild = () => {
      dirty = false; runs = []; controls = [];
      const fillsCache = new Map<Element, number[][]>();
      const fills = (el: Element): number[][] => {
        if (el === document.body || el === document.documentElement) return [];
        const cached = fillsCache.get(el); if (cached) return cached;
        const parent = el.parentElement && el !== document.documentElement ? fills(el.parentElement) : [];
        const fill = rgba(getComputedStyle(el).backgroundColor);
        const result = fill[3] ? [...parent, fill] : parent;
        fillsCache.set(el, result); return result;
      };
      for (const root of document.querySelectorAll(ROOTS)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || !node.textContent?.trim() || parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        } });
        let node: Node | null;
        while ((node = walker.nextNode()) && runs.length < 3500) {
          const parent = node.parentElement!, style = getComputedStyle(parent);
          if (style.visibility !== "visible" || style.display === "none" || !visible(parent.getBoundingClientRect())) continue;
          for (const part of words.segment(node.textContent!)) {
            if (!part.segment.trim()) continue;
            const range = document.createRange(); range.setStart(node, part.index); range.setEnd(node, part.index + part.segment.length);
            const rect = range.getBoundingClientRect();
            if (visible(rect)) runs.push({ range, rect, fills: fills(parent) });
            if (runs.length >= 3500) break;
          }
        }
        for (const element of root.querySelectorAll<HTMLElement>('input:not([type="checkbox"]):not([type="range"]), textarea, select, button, [data-wallpaper-contrast-icon]')) {
          if (element.closest('[role="alert"], [style*="--status-"], [data-wallpaper-contrast="off"]')) continue;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (visible(rect) && style.visibility === "visible") {
            let x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
            if (element.matches('input, textarea, select')) {
              const font = parseFloat(style.fontSize) || 16;
              const right = style.textAlign === 'right' || (style.textAlign === 'start' && style.direction === 'rtl');
              if (style.textAlign !== 'center') x = right
                ? rect.right - parseFloat(style.paddingRight) - font
                : rect.left + parseFloat(style.paddingLeft) + font;
              if (element instanceof HTMLTextAreaElement) y = rect.top + parseFloat(style.paddingTop) + (parseFloat(style.lineHeight) || font * 1.2) / 2;
            }
            controls.push({ element, x, y, fills: fills(element) });
          }
        }
        if (root instanceof HTMLButtonElement) {
          const r = root.getBoundingClientRect();
          if (visible(r)) controls.push({ element: root, x: r.left + r.width / 2, y: r.top + r.height / 2, fills: fills(root) });
        }
      }
    };
    const paint = () => {
      if (stopped || document.hidden) return;
      const media = document.querySelector<HTMLImageElement | HTMLVideoElement | HTMLCanvasElement>(".wallpaper-backdrop > img, .wallpaper-backdrop > video, .wallpaper-backdrop > canvas");
      if (!media) return;
      const width = media instanceof HTMLImageElement ? media.naturalWidth : media instanceof HTMLVideoElement ? media.videoWidth : media.width;
      const height = media instanceof HTMLImageElement ? media.naturalHeight : media instanceof HTMLVideoElement ? media.videoHeight : media.height;
      if (!width || !height) return;
      try {
        if (dirty) rebuild();
        const viewport = { width: innerWidth, height: innerHeight };
        surface.height = Math.max(3, Math.min(1024, Math.round(320 * viewport.height / viewport.width)));
        const scale = 320 / viewport.width;
        const scaleY = surface.height / viewport.height;
        ctx.filter = "none"; ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#202020";
        ctx.fillRect(0, 0, surface.width, surface.height);
        const rect = mediaRect({ width, height }, viewport, p.fit, p.positionX, p.positionY);
        ctx.filter = `brightness(${p.brightness}%)`;
        ctx.drawImage(media, rect.x * scale, rect.y * scaleY, rect.width * scale, rect.height * scaleY);
        const pixels = ctx.getImageData(0, 0, surface.width, surface.height).data;
        const background = (x: number, y: number, fills: number[][]): Rgb => {
          const xx = Math.max(1, Math.min(surface.width - 2, Math.round(x * scale)));
          const yy = Math.max(1, Math.min(surface.height - 2, Math.round(y * scaleY)));
          let rgb: Rgb = [0, 0, 0];
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const i = ((yy + dy) * surface.width + xx + dx) * 4;
            for (let c = 0; c < 3; c++) rgb[c] += pixels[i + c] / 9;
          }
          // The body/root fill is behind the wallpaper, not in front of it.
          for (const fill of fills) rgb = composite(rgb, fill);
          return rgb;
        };
        const dark = new Highlight(), light = new Highlight(); dark.priority = light.priority = -100;
        const add = (range: Range, ink: Ink) => (ink === "dark" ? dark : light).add(range);
        for (const run of runs) {
          if (!run.range.startContainer.isConnected) { dirty = true; continue; }
          const { rect: r, fills } = run, y = r.top + r.height / 2;
          run.ink = chooseInk(background(r.left + r.width / 2, y, fills), run.ink);
          const left = chooseInk(background(r.left, y, fills)), right = chooseInk(background(r.right, y, fills));
          if ((left === right && left === run.ink && run.range.getClientRects().length === 1) || run.range.toString().length <= 1) add(run.range, run.ink);
          else {
            // Highlight ranges leave React's text nodes, selection and copy intact.
            for (const part of glyphs.segment(run.range.toString())) {
              const range = document.createRange(); range.setStart(run.range.startContainer, run.range.startOffset + part.index); range.setEnd(run.range.startContainer, run.range.startOffset + part.index + part.segment.length);
              const r = range.getBoundingClientRect(); add(range, chooseInk(background(r.left + r.width / 2, r.top + r.height / 2, fills)));
            }
          }
        }
        CSS.highlights.set("wallpaper-ink-dark", dark); CSS.highlights.set("wallpaper-ink-light", light);
        const active = new Set<HTMLElement>();
        for (const control of controls) {
          const { element, x, y, fills } = control;
          control.ink = chooseInk(background(x, y, fills), control.ink);
          element.dataset.wallpaperInk = control.ink; touched.add(element); active.add(element);
        }
        for (const el of touched) if (!active.has(el)) { delete el.dataset.wallpaperInk; touched.delete(el); }
      } catch {
        // Cross-origin/unsupported media must not break chat or leak stale colors.
        CSS.highlights.delete("wallpaper-ink-dark"); CSS.highlights.delete("wallpaper-ink-light");
        for (const el of touched) delete el.dataset.wallpaperInk;
        touched.clear();
      }
    };
    const invalidate = () => { dirty = true; };
    const observer = new MutationObserver(invalidate);
    for (const root of document.querySelectorAll(ROOTS)) observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-glass"] });
    window.addEventListener("resize", invalidate); document.addEventListener("scroll", invalidate, true);
    document.addEventListener("visibilitychange", invalidate);
    void document.fonts.ready.then(invalidate);
    // No work on the render loop; two small local samples per second.
    const timer = window.setInterval(paint, 500); paint();
    return () => {
      stopped = true; clearInterval(timer); observer.disconnect();
      window.removeEventListener("resize", invalidate); document.removeEventListener("scroll", invalidate, true); document.removeEventListener("visibilitychange", invalidate);
      CSS.highlights.delete("wallpaper-ink-dark"); CSS.highlights.delete("wallpaper-ink-light");
      for (const el of touched) delete el.dataset.wallpaperInk;
    };
  }, [p.adaptiveText, p.id, p.kind, p.fit, p.positionX, p.positionY, p.brightness, p.glass, p.glassOpacity, ready]);
}
