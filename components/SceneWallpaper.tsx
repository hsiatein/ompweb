"use client";
import { useEffect, useRef, type CSSProperties } from "react";
import type { BrowserSceneRenderer } from "@/lib/wallpaper-scene-renderer";
import { WallpaperAudio, activateWallpaperAudio } from "@/lib/wallpaper-audio";

export function SceneWallpaper({ id, paused, volume = 50, muted = false, style, onReady, onError }: {
  id: string; paused: boolean; volume?: number; muted?: boolean; style: CSSProperties; onReady: () => void; onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<BrowserSceneRenderer | null>(null);
  const pause = useRef(paused);
  const audio = useRef<WallpaperAudio | null>(null);
  const audioSettings = useRef({ paused, volume, muted });
  useEffect(() => { audioSettings.current = { paused, volume, muted }; audio.current?.configure(audioSettings.current); }, [paused, volume, muted]);
  const callbacks = useRef({ onReady, onError });
  useEffect(() => { callbacks.current = { onReady, onError }; }, [onReady, onError]);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    async function load() {
      try {
        const response = await fetch(`/api/wallpapers/${encodeURIComponent(id)}/scene`, { signal: controller.signal });
        if (!response.ok) throw new Error((await response.json()).error || "Scene renderer unavailable");
        const data = await response.json();
        if (canvas.current) canvas.current.dataset.compatibilityWarnings = JSON.stringify(data.warnings || []);
        const { BrowserSceneRenderer } = await import("@/lib/wallpaper-scene-renderer");
        if (disposed || !canvas.current) return;
        const engine = await BrowserSceneRenderer.create(canvas.current, data, controller.signal, message => callbacks.current.onError(message));
        if (disposed) { engine.dispose(); return; }
        renderer.current = engine;
        audio.current = new WallpaperAudio(data.sounds || [], audioSettings.current);
        activateWallpaperAudio(audio.current);
        engine.setAudio(audio.current);
        engine.setPaused(pause.current);
        callbacks.current.onReady();
      } catch (error) {
        if (!controller.signal.aborted && !disposed) callbacks.current.onError((error as Error).message);
      }
    }
    void load();
    return () => { disposed = true; controller.abort(); audio.current?.dispose(); audio.current = null; renderer.current?.dispose(); renderer.current = null; };
  }, [id]);
  useEffect(() => { pause.current = paused; renderer.current?.setPaused(paused); }, [paused]);
  return <canvas key={id} ref={canvas} className="wallpaper-scene" data-renderer="browser-webgl" style={style} />;
}
