"use client";
import { useEffect, useRef, type CSSProperties } from "react";
import type { BrowserSceneRenderer } from "@/lib/wallpaper-scene-renderer";
import { WallpaperAudio, activateWallpaperAudio } from "@/lib/wallpaper-audio";
import { sceneAudioCache, sceneManifest } from "@/lib/wallpaper-client-cache";

export function SceneWallpaper({ id, paused, form = "", volume = 50, muted = false, bgm = null, style, onReady, onError }: {
  id: string; paused: boolean; form?: string; volume?: number; muted?: boolean; bgm?: string | null; style: CSSProperties; onReady: () => void; onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<BrowserSceneRenderer | null>(null);
  const pause = useRef(paused);
  const selectedForm = useRef(form);
  useEffect(() => { selectedForm.current = form; renderer.current?.setForm(form); }, [form]);
  const audio = useRef<WallpaperAudio | null>(null);
  const audioSettings = useRef({ paused, volume, muted });
  const replacement = useRef(bgm);
  useEffect(() => { replacement.current = bgm; audio.current?.setReplacement(bgm); }, [bgm]);
  useEffect(() => { audioSettings.current = { paused, volume, muted }; audio.current?.configure(audioSettings.current); }, [paused, volume, muted]);
  const callbacks = useRef({ onReady, onError });
  useEffect(() => { callbacks.current = { onReady, onError }; }, [onReady, onError]);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    async function load() {
      try {
        const [data, { BrowserSceneRenderer }] = await Promise.all([
          sceneManifest(id, controller.signal),
          import("@/lib/wallpaper-scene-renderer"),
        ]);
        if (canvas.current) canvas.current.dataset.compatibilityWarnings = JSON.stringify(data.warnings || []);
        if (disposed || !canvas.current) return;
        const engine = await BrowserSceneRenderer.create(canvas.current, data, controller.signal, message => callbacks.current.onError(message), selectedForm.current);
        if (disposed) { engine.dispose(); return; }
        renderer.current = engine;
        engine.setForm(selectedForm.current);
        audio.current = new WallpaperAudio(data.sounds || [], audioSettings.current, undefined, replacement.current, sceneAudioCache(controller.signal));
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
