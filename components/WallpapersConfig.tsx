"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FolderPlus, Image, RefreshCw, Upload, Trash2, Video, Box, Power } from "lucide-react";
import { useWallpaperPreferences } from "@/hooks/useWallpaper";
import { useI18n } from "@/lib/i18n";
import { wallpaperUrl, type WallpaperInfo, type WallpaperTextMode } from "@/lib/wallpapers";
import { WallpaperControls } from "./WallpaperControls";
import { WallpaperCrop } from "./WallpaperCrop";

type Library = { wallpapers: WallpaperInfo[]; roots: string[]; warnings: string[] };
export function WallpapersConfig() {
  const { locale } = useI18n();
  const zh = locale.startsWith("zh");
  const { preferences: p, update } = useWallpaperPreferences();
  const [colorDraft, setColorDraft] = useState<string | null>(null);
  const colorInput = colorDraft ?? p.textColor;
  function commitColor() {
    if (/^#[0-9a-f]{6}$/i.test(colorInput)) update({ textColor: colorInput.toLowerCase() });
    setColorDraft(null);
  }
  const [library, setLibrary] = useState<Library>({ wallpapers: [], roots: [], warnings: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [sceneAvailable, setSceneAvailable] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upload = useRef<XMLHttpRequest | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch("/api/wallpapers?refresh=1", { signal });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    setLibrary(data);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(e => { if (!controller.signal.aborted) setError(String(e.message)); });
    void fetch("/api/wallpapers/scene-status", { signal: controller.signal }).then(r => r.json()).then(status => setSceneAvailable(status.available === true)).catch(() => {});
    return () => { controller.abort(); upload.current?.abort(); };
  }, [refresh]);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(String((e as Error).message)); }
    finally { setBusy(false); }
  }
  async function mutate(method: string, data: object) {
    const res = await fetch("/api/wallpapers", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (!res.ok) throw new Error((await res.json()).error);
    await refresh();
  }
  function importFile(file: File) {
    if (file.size > 512 * 1024 * 1024) { setError(zh ? "文件上限 512 MiB；大视频请添加服务器文件夹。" : "Upload limit: 512 MiB. Add a server folder for larger videos."); return; }
    void action(async () => {
      setProgress(0);
      try {
        const data = await new Promise<{ id: string; kind: "video" | "image" }>((resolve, reject) => {
          const xhr = new XMLHttpRequest(); upload.current = xhr;
          xhr.open("POST", `/api/wallpapers/upload?name=${encodeURIComponent(file.name)}`);
          xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round(100 * e.loaded / e.total)); };
          xhr.onload = () => {
            try { const result = JSON.parse(xhr.responseText); if (xhr.status >= 400) reject(new Error(result.error)); else resolve(result); }
            catch { reject(new Error(zh ? "上传失败" : "Upload failed")); }
          };
          xhr.onerror = () => reject(new Error(zh ? "上传连接中断" : "Upload connection failed"));
          xhr.onabort = () => reject(new Error(zh ? "上传已取消" : "Upload cancelled"));
          xhr.send(file);
        });
        update({ ...data, paused: false });
        await refresh();
      } finally { setProgress(null); upload.current = null; }
    });
  }
  const visible = library.wallpapers.filter(w => w.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const kindName = (w: WallpaperInfo) => w.kind === "web" ? (zh ? "网页 · 本地渲染" : "Web · local rendering") : w.kind === "scene" ? (sceneAvailable ? (zh ? "场景 · 本地高清" : "Scene · local HD") : (zh ? "场景 · 加载中" : "Scene · loading")) : w.kind === "unsupported" ? (w.reason || (zh ? "暂不支持" : "Unsupported")) : w.kind === "video" ? (zh ? "视频" : "Video") : (zh ? "图片" : "Image");
  return <section className="wallpaper-settings">
    <div className="wallpaper-toolbar">
      <h2>{zh ? "壁纸" : "Wallpapers"}</h2>
      <button type="button" className="wallpaper-command" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{zh ? "导入" : "Import"}</button>
      <button type="button" className="wallpaper-icon" title={zh ? "刷新壁纸库" : "Refresh library"} aria-label={zh ? "刷新壁纸库" : "Refresh library"} disabled={busy} onClick={() => void action(() => refresh())}><RefreshCw size={16} /></button>
      <button type="button" className="wallpaper-icon" title={zh ? "关闭壁纸" : "Disable wallpaper"} aria-label={zh ? "关闭壁纸" : "Disable wallpaper"} disabled={!p.id} onClick={() => update({ id: null })}><Power size={16} /></button>
      <input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.gif,.avif,.mp4,.webm" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) importFile(file); }} />
    </div>
    <div className="wallpaper-options">
      <WallpaperControls />
      <label><input type="checkbox" checked={p.adaptiveText} onChange={e => update({ adaptiveText: e.target.checked })} />{zh ? "文字配色" : "Text colors"}</label>
      <select aria-label={zh ? "文字配色模式" : "Text color mode"} disabled={!p.adaptiveText} value={p.textMode} onChange={e => update({ textMode: e.target.value as WallpaperTextMode })}>
        <option value="fixed">{zh ? "固定颜色" : "Fixed color"}</option>
        <option value="auto">{zh ? "自动黑白" : "Automatic black / white"}</option>
        <option value="material">{zh ? "Material 配色" : "Material colors"}</option>
      </select>
      {p.textMode === "fixed" && <span className="wallpaper-text-color">
        <input type="color" aria-label={zh ? "文字颜色" : "Text color"} disabled={!p.adaptiveText} value={p.textColor} onChange={e => { setColorDraft(null); update({ textColor: e.target.value }); }} />
        <input type="text" aria-label={zh ? "文字颜色 HEX" : "Text color HEX"} disabled={!p.adaptiveText} value={colorInput} maxLength={7} spellCheck={false} onChange={e => setColorDraft(e.target.value)} onBlur={commitColor} onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); commitColor(); }
          if (e.key === "Escape") setColorDraft(null);
        }} />
      </span>}
      <label><input type="checkbox" checked={p.adaptivePalette} onChange={e => update({ adaptivePalette: e.target.checked })} />{zh ? "壁纸配色" : "Wallpaper colors"}<span className="wallpaper-palette-swatches" aria-hidden="true"><i /><i /><i /></span></label>
      <label>{zh ? "填充" : "Fit"}<select value={p.fit} onChange={e => update({ fit: e.target.value as "cover" | "contain" })}><option value="cover">{zh ? "铺满" : "Cover"}</option><option value="contain">{zh ? "完整显示" : "Contain"}</option></select></label>
      <label>{zh ? "亮度" : "Brightness"}<input aria-label={zh ? "壁纸亮度" : "Wallpaper brightness"} type="range" min="20" max="100" value={p.brightness} onChange={e => update({ brightness: Number(e.target.value) })} /><output>{p.brightness}%</output></label>
      <label>{zh ? "玻璃不透明度" : "Glass opacity"}<input aria-label={zh ? "玻璃不透明度" : "Glass opacity"} type="range" min="0" max="100" disabled={p.glass === "clear"} value={p.glassOpacity} onChange={e => update({ glassOpacity: Number(e.target.value) })} /><output>{p.glassOpacity}%</output></label>
    </div>
    {p.id && p.kind !== "web" && <WallpaperCrop key={p.id} />}
    <form className="wallpaper-folder" onSubmit={e => { e.preventDefault(); void action(async () => { await mutate("POST", { folder }); setFolder(""); }); }}>
      <input aria-label={zh ? "服务器壁纸文件夹" : "Server wallpaper folder"} placeholder={zh ? "服务器壁纸文件夹的完整路径" : "Absolute server wallpaper folder"} value={folder} onChange={e => setFolder(e.target.value)} />
      <button className="wallpaper-icon" type="submit" disabled={busy || !folder.trim()} title={zh ? "添加文件夹" : "Add folder"} aria-label={zh ? "添加文件夹" : "Add folder"}><FolderPlus size={17} /></button>
    </form>
    {progress !== null && <div className="wallpaper-progress" role="status"><progress value={progress} max="100" /><span>{progress}%</span><button type="button" onClick={() => upload.current?.abort()}>{zh ? "取消" : "Cancel"}</button></div>}
    {error && <p role="alert" className="wallpaper-warning">{error}</p>}
    <div className="wallpaper-library-heading"><span>{library.wallpapers.length} {zh ? "项" : "items"}</span><input type="search" aria-label={zh ? "搜索壁纸" : "Search wallpapers"} placeholder={zh ? "搜索壁纸" : "Search wallpapers"} value={query} onChange={e => setQuery(e.target.value)} /></div>
    <div className="wallpaper-grid">
      {visible.map(w => {
        const supported = w.kind === "image" || w.kind === "video" || w.kind === "web" || (w.kind === "scene" && sceneAvailable);
        const Icon = w.kind === "video" ? Video : w.kind === "image" ? Image : Box;
        return <article className="wallpaper-item" key={w.id} data-selected={p.id === w.id}>
          <button className="wallpaper-select" type="button" disabled={!supported || busy} aria-label={w.title} aria-pressed={p.id === w.id} onClick={() => update({ id: w.id, kind: w.kind as "image" | "video" | "scene" | "web", paused: false })}>
            <div className="wallpaper-thumbnail">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {w.preview ? <img src={wallpaperUrl(w.id, true)} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = "hidden"; }} /> : <Icon size={28} />}
              {p.id === w.id && <span className="wallpaper-selected"><Check size={16} /></span>}
            </div>
            <div className="wallpaper-item-label"><span title={w.title}>{w.title}</span><small>{kindName(w)}</small></div>
          </button>
          {w.source === "imported" && <button type="button" className="wallpaper-delete" disabled={busy} title={zh ? "删除导入壁纸" : "Delete imported wallpaper"} aria-label={`${zh ? "删除" : "Delete"} ${w.title}`} onClick={() => {
            if (!window.confirm(zh ? `删除导入的壁纸“${w.title}”？` : `Delete imported wallpaper "${w.title}"?`)) return;
            void action(async () => { await mutate("DELETE", { id: w.id }); if (p.id === w.id) update({ id: null }); });
          }}><Trash2 size={14} /></button>}
        </article>;
      })}
    </div>
    {!visible.length && <p className="wallpaper-empty">{busy ? (zh ? "正在读取…" : "Loading…") : (zh ? "没有匹配的壁纸" : "No matching wallpapers")}</p>}
    <details className="wallpaper-folders"><summary>{zh ? "已扫描目录" : "Scanned folders"} ({library.roots.length})</summary>{library.roots.map(r => <div key={r}>{r}</div>)}{library.warnings.map((w, i) => <div key={i} className="wallpaper-warning">{w}</div>)}</details>
  </section>;
}
