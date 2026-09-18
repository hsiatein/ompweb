"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";

export function WebWallpaper({ id, paused, volume = 50, muted = false, style, onReady, onError }: { id: string; paused: boolean; volume?: number; muted?: boolean; style: CSSProperties; onReady: () => void; onError: (message: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const loadingTimer = useRef<number | undefined>(undefined);
  const [url, setUrl] = useState("");
  const callbacks = useRef({ onReady, onError });
  useEffect(() => { callbacks.current = { onReady, onError }; }, [onReady, onError]);
  useEffect(() => {
    const timeout = window.setTimeout(() => callbacks.current.onError("Web wallpaper did not finish loading. Check its local resources."), 30000);
    loadingTimer.current = timeout;
    const ac = new AbortController();
    void fetch(`/api/wallpapers/${id}/web`, { signal: ac.signal }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setUrl(d.url); }).catch(e => { if (!ac.signal.aborted) callbacks.current.onError(e.message); });
    return () => { ac.abort(); clearTimeout(timeout); };
  }, [id]);
  useEffect(() => {
    const sync = () => frame.current?.contentWindow?.postMessage({ type: "omp-wallpaper-state", paused: paused || document.hidden, volume: muted ? 0 : volume / 100 }, "*");
    const message = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "omp-wallpaper-ready") { clearTimeout(loadingTimer.current); sync(); callbacks.current.onReady(); }
      if (event.data?.type === "omp-wallpaper-error") callbacks.current.onError(String(event.data.message));
    };
    sync(); window.addEventListener("message", message); document.addEventListener("visibilitychange", sync);
    window.addEventListener("pointerdown", sync, true); window.addEventListener("keydown", sync, true);
    return () => { window.removeEventListener("message", message); document.removeEventListener("visibilitychange", sync); window.removeEventListener("pointerdown", sync, true); window.removeEventListener("keydown", sync, true); };
  }, [paused, volume, muted, url]);
  return url ? <iframe ref={frame} className="wallpaper-web" src={url} title="Wallpaper" sandbox="allow-scripts" allow="autoplay" referrerPolicy="no-referrer" tabIndex={-1} style={{ ...style, width: "100%", height: "100%", border: 0 }} /> : null;
}
