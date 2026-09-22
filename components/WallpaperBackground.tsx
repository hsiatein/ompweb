"use client";
import { useEffect, useRef, useState } from "react";
import { useWallpaperPreferences } from "@/hooks/useWallpaper";
import { wallpaperUrl } from "@/lib/wallpapers";
import { useI18n } from "@/lib/i18n";
import { X } from "lucide-react";
import { SceneWallpaper } from "./SceneWallpaper";
import { WebWallpaper } from "./WebWallpaper";
import { useWallpaperContrast } from "@/hooks/useWallpaperContrast";
import { useWallpaperPalette } from "@/hooks/useWallpaperPalette";

export function WallpaperBackground() {
  const { preferences: p, update } = useWallpaperPreferences();
  const { locale } = useI18n();
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  useWallpaperContrast(p, loadedId === p.id && failedId !== p.id);
  useWallpaperPalette(p, loadedId === p.id && failedId !== p.id);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.wallpaper = p.id && loadedId === p.id && failedId !== p.id ? "on" : "off";
    root.dataset.glass = p.glass;
    root.style.setProperty("--wallpaper-glass-opacity", `${p.glassOpacity}%`);
    return () => { delete root.dataset.wallpaper; delete root.dataset.glass; root.style.removeProperty("--wallpaper-glass-opacity"); };
  }, [p.id, p.glass, p.glassOpacity, loadedId, failedId]);
  useEffect(() => { if (video.current) { video.current.volume = p.volume / 100; video.current.muted = p.muted; } }, [p.id, p.volume, p.muted]);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const sync = () => {
      if (p.paused || document.hidden) el.pause();
      else void el.play().catch(() => { /* autoplay may require a user gesture */ });
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("pointerdown", sync, true); window.addEventListener("keydown", sync, true);
    return () => { document.removeEventListener("visibilitychange", sync); window.removeEventListener("pointerdown", sync, true); window.removeEventListener("keydown", sync, true); el.pause(); };
  }, [p.id, p.paused]);
  if (!p.id) return null;
  const ready = () => { setLoadedId(p.id); setFailedId(null); };
  const mediaStyle = { objectFit: p.fit, objectPosition: `${p.positionX}% ${p.positionY}%`, filter: `brightness(${p.brightness}%)` };
  return <>
    <div className="wallpaper-backdrop" data-wallpaper-id={p.id} aria-hidden="true" style={{ opacity: loadedId === p.id && failedId !== p.id ? 1 : 0 }}>
      {p.kind === "web"
        ? <WebWallpaper key={p.id} id={p.id} paused={p.paused} volume={p.volume} muted={p.muted} style={mediaStyle} onReady={ready} onError={message => { setSceneError(message); setFailedId(p.id); }} />
        : p.kind === "scene"
        ? <SceneWallpaper key={p.id} id={p.id} paused={p.paused} volume={p.volume} muted={p.muted} onReady={ready} onError={message => { setSceneError(message); setFailedId(p.id); }} style={mediaStyle} />
        : p.kind === "video"
        ? <video key={p.id} ref={video} src={wallpaperUrl(p.id)} muted={p.muted} loop playsInline preload="auto" onLoadedData={ready} onError={() => setFailedId(p.id)} style={mediaStyle} />
        // Keep animated raster files intact instead of re-encoding via Next Image.
        // eslint-disable-next-line @next/next/no-img-element
        : <img key={p.id} src={wallpaperUrl(p.id)} alt="" onLoad={ready} onError={() => setFailedId(p.id)} style={mediaStyle} />}
    </div>
    {failedId === p.id && <div className="wallpaper-error" role="alert">
      {p.kind === "scene" || p.kind === "web" ? `${locale.startsWith("zh") ? "场景渲染失败" : "Scene rendering failed"}: ${sceneError}` : locale.startsWith("zh") ? "壁纸加载失败，文件可能已移动或浏览器不支持此视频编码。" : "Wallpaper unavailable. The file may have moved or its codec is unsupported."}
      <button type="button" aria-label={locale.startsWith("zh") ? "关闭壁纸" : "Disable wallpaper"} onClick={() => update({ id: null })}><X size={16} /></button>
    </div>}
  </>;
}
