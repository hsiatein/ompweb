"use client";
import { useEffect } from "react";
import type { WallpaperPreferences } from "@/lib/wallpapers";

const ROOTS = ".wallpaper-shell, .wallpaper-panel-toggle";
// Keep semantic colors and genuinely filled buttons, but opt glass actions in.
const PROTECTED = '[role="alert"], [style*="--status-"], [style*="--on-accent"]:not(.wallpaper-inset), [data-wallpaper-contrast="off"], .file-diff-view, .wallpaper-thumbnail, pre, code, mark';
const SKIP = PROTECTED + ', script, style, noscript, svg, input, textarea, select, option, [contenteditable="true"]';
const CONTROLS = 'input:not([type="checkbox"]):not([type="range"]):not([type="file"]):not([type="color"]), textarea, select, button, [data-wallpaper-contrast-icon]';

export function useWallpaperContrast(p: WallpaperPreferences, ready: boolean) {
  useEffect(() => {
    if (!p.adaptiveText || !p.id || !ready) return;
    const touched = new Set<HTMLElement>();
    let timer = 0, stopped = false;
    const paint = () => {
      timer = 0;
      if (stopped || document.hidden) return;
      const active = new Set<HTMLElement>();
      const add = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight || getComputedStyle(el).visibility !== "visible") return false;
        if (el.dataset.wallpaperInk !== "global") el.dataset.wallpaperInk = "global";
        active.add(el); touched.add(el); return true;
      };
      for (const root of document.querySelectorAll<HTMLElement>(ROOTS)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) {
          return node.textContent?.trim() && node.parentElement && !node.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        } });
        let node: Node | null, count = 0;
        while ((node = walker.nextNode()) && count < 6000) if (node.parentElement instanceof HTMLElement && add(node.parentElement)) count++;
        for (const el of root.querySelectorAll<HTMLElement>(CONTROLS)) if (!el.closest(PROTECTED)) add(el);
        if (root.matches(CONTROLS) && !root.closest(PROTECTED)) add(root);
      }
      for (const el of touched) if (!active.has(el)) { delete el.dataset.wallpaperInk; touched.delete(el); }
    };
    const schedule = () => { if (!stopped && !timer) timer = window.setTimeout(paint, 100); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "data-wallpaper-contrast"] });
    const resize = new ResizeObserver(schedule);
    for (const root of document.querySelectorAll(ROOTS)) resize.observe(root);
    document.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule); void document.fonts.ready.then(schedule);
    paint();
    return () => {
      stopped = true; clearTimeout(timer); observer.disconnect(); resize.disconnect();
      document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); document.removeEventListener("visibilitychange", schedule);
      for (const el of touched) delete el.dataset.wallpaperInk;
    };
  }, [p.adaptiveText, p.id, ready]);
}
