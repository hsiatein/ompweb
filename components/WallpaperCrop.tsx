"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Crosshair, Monitor } from "lucide-react";
import { useWallpaperPreferences } from "@/hooks/useWallpaper";
import { useI18n } from "@/lib/i18n";
import { moveWallpaperCrop, wallpaperCropGeometry, type WallpaperCropGeometry } from "@/lib/wallpaper-crop";

type Media = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
function mediaSize(source: Media) {
  if (source instanceof HTMLImageElement) return { width: source.naturalWidth, height: source.naturalHeight };
  if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight };
  return { width: source.width, height: source.height };
}

export function WallpaperCrop() {
  const { preferences: p, update } = useWallpaperPreferences();
  const { locale } = useI18n();
  const zh = locale.startsWith("zh");
  const canvas = useRef<HTMLCanvasElement>(null);
  const geometry = useRef<WallpaperCropGeometry | null>(null);
  const drag = useRef<{ pointer: number; offsetX: number; offsetY: number } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0, canX: false, canY: false, ready: false });

  useEffect(() => {
    const el = canvas.current;
    const context = el?.getContext("2d");
    if (!el || !context) return;
    let frame = 0;
    let last = -Infinity;
    function draw(now: number) {
      frame = requestAnimationFrame(draw);
      if (document.hidden || now - last < 100) return;
      last = now;
      const width = el!.clientWidth, height = el!.clientHeight;
      if (!width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (el!.width !== Math.round(width * dpr) || el!.height !== Math.round(height * dpr)) {
        el!.width = Math.round(width * dpr); el!.height = Math.round(height * dpr);
      }
      context!.setTransform(dpr, 0, 0, dpr, 0, 0);
      context!.clearRect(0, 0, width, height);
      const backdrop = document.querySelector<HTMLElement>(`.wallpaper-backdrop[data-wallpaper-id="${p.id}"]`);
      // Reuse the backing media instead of opening a second scene stream.
      const source = backdrop?.querySelector<Media>("img, video, canvas");
      const viewport = { width: backdrop?.clientWidth || window.innerWidth, height: backdrop?.clientHeight || window.innerHeight };
      const g = source && document.documentElement.dataset.wallpaper === "on"
        ? wallpaperCropGeometry(mediaSize(source), { width, height }, viewport, { positionX: p.positionX, positionY: p.positionY }, p.fit) : null;
      geometry.current = g;
      setDimensions(previous => {
        const next = { ...viewport, canX: (g?.travelX || 0) > 0.01, canY: (g?.travelY || 0) > 0.01, ready: !!g };
        return Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next;
      });
      if (!g || !source) return;
      const { image: imageRect, crop } = g;
      context!.drawImage(source, imageRect.x, imageRect.y, imageRect.width, imageRect.height);
      if (p.fit === "contain") return;
      context!.fillStyle = "rgba(0, 0, 0, 0.58)";
      context!.beginPath();
      context!.rect(imageRect.x, imageRect.y, imageRect.width, imageRect.height);
      context!.rect(crop.x, crop.y, crop.width, crop.height);
      context!.fill("evenodd");
      context!.strokeStyle = "rgba(0, 0, 0, 0.8)";
      context!.lineWidth = 3;
      context!.strokeRect(crop.x + 1.5, crop.y + 1.5, Math.max(0, crop.width - 3), Math.max(0, crop.height - 3));
      context!.strokeStyle = "white";
      context!.lineWidth = 1;
      context!.strokeRect(crop.x + 1.5, crop.y + 1.5, Math.max(0, crop.width - 3), Math.max(0, crop.height - 3));
    }
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [p.id, p.fit, p.positionX, p.positionY]);

  function point(e: PointerEvent<HTMLCanvasElement>) {
    const bounds = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
  }
  function move(e: PointerEvent<HTMLCanvasElement>) {
    const g = geometry.current, d = drag.current;
    if (!g || !d || d.pointer !== e.pointerId || p.fit !== "cover") return;
    const { x, y } = point(e);
    update(moveWallpaperCrop(g, x - d.offsetX, y - d.offsetY, p));
  }
  function start(e: PointerEvent<HTMLCanvasElement>) {
    const g = geometry.current;
    if (!e.isPrimary || e.button !== 0 || !g || p.fit !== "cover" || (!dimensions.canX && !dimensions.canY)) return;
    const { x, y } = point(e), { crop, image } = g;
    if (x < image.x || x > image.x + image.width || y < image.y || y > image.y + image.height) return;
    const inside = x >= crop.x && x <= crop.x + crop.width && y >= crop.y && y <= crop.y + crop.height;
    drag.current = { pointer: e.pointerId, offsetX: inside ? x - crop.x : crop.width / 2, offsetY: inside ? y - crop.y : crop.height / 2 };
    e.currentTarget.setPointerCapture(e.pointerId);
    move(e);
  }
  function end(e: PointerEvent<HTMLCanvasElement>) {
    if (drag.current?.pointer !== e.pointerId) return;
    if (e.type === "pointerup") move(e);
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return <div className="wallpaper-crop">
    <div className="wallpaper-crop-heading">
      <h3>{zh ? "裁剪位置" : "Crop position"}</h3>
      <span><Monitor size={14} />{dimensions.width ? `${dimensions.width} × ${dimensions.height}` : ""}</span>
      <button className="wallpaper-icon" type="button" title={zh ? "居中裁剪" : "Center crop"} aria-label={zh ? "居中裁剪" : "Center crop"} disabled={p.positionX === 50 && p.positionY === 50} onClick={() => update({ positionX: 50, positionY: 50 })}><Crosshair size={17} /></button>
    </div>
    <div className="wallpaper-crop-body">
      <div className="wallpaper-crop-preview">
        <canvas ref={canvas} role="img" aria-label={zh ? "壁纸裁剪预览" : "Wallpaper crop preview"} title={zh ? "拖动裁剪框" : "Drag crop selection"} data-movable={dimensions.canX || dimensions.canY} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => { drag.current = null; }} />
        {!dimensions.ready && <span role="status">{zh ? "等待壁纸画面" : "Waiting for wallpaper"}</span>}
      </div>
      <div className="wallpaper-crop-sliders">
        <label>{zh ? "横向" : "Horizontal"}<input type="range" min="0" max="100" step="0.1" aria-label={zh ? "横向裁剪位置" : "Horizontal crop position"} disabled={!dimensions.canX} value={p.positionX} onChange={e => update({ positionX: Number(e.target.value) })} /><output>{Math.round(p.positionX)}%</output></label>
        <label>{zh ? "纵向" : "Vertical"}<input type="range" min="0" max="100" step="0.1" aria-label={zh ? "纵向裁剪位置" : "Vertical crop position"} disabled={!dimensions.canY} value={p.positionY} onChange={e => update({ positionY: Number(e.target.value) })} /><output>{Math.round(p.positionY)}%</output></label>
      </div>
    </div>
  </div>;
}
