"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderPlus, Image, RefreshCw, Upload, Trash2, Video, Box, Power } from "lucide-react";
import { useWallpaperPreferences } from "@/hooks/useWallpaper";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { selectWallpapers, wallpaperUrl, type WallpaperInfo, type WallpaperTextMode, type WallpaperOrientation, type WallpaperSort, type WallpaperKindFilter } from "@/lib/wallpapers";
import { WallpaperControls } from "./WallpaperControls";
import { WallpaperCrop } from "./WallpaperCrop";
import { WallpaperBgmConfig } from "./WallpaperBgmConfig";
import { Select } from "./ui/field";
import { sceneManifest } from "@/lib/wallpaper-client-cache";
import type { SceneForm } from "@/lib/wallpaper-scene-types";

type Library = { wallpapers: WallpaperInfo[]; roots: string[]; warnings: string[] };
export function WallpapersConfig() {
  const { locale, t } = useI18n();
  const { preferences: p, update } = useWallpaperPreferences();
  const mobile = useIsMobile();
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
  const [formCatalog, setFormCatalog] = useState<{ id: string; forms: SceneForm[] } | null>(null);
  useEffect(() => {
    if (!p.id || p.kind !== "scene") return;
    const id = p.id, controller = new AbortController();
    void sceneManifest(id, controller.signal).then(scene => {
      if (!controller.signal.aborted) setFormCatalog({ id, forms: scene.forms || [] });
    }).catch(error => { if (!controller.signal.aborted) setError(String(error.message)); });
    return () => controller.abort();
  }, [p.id, p.kind]);
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
    if (file.size > 512 * 1024 * 1024) { setError(t("wallpaper.uploadLimit")); return; }
    void action(async () => {
      setProgress(0);
      try {
        const data = await new Promise<{ id: string; kind: "video" | "image" }>((resolve, reject) => {
          const xhr = new XMLHttpRequest(); upload.current = xhr;
          xhr.open("POST", `/api/wallpapers/upload?name=${encodeURIComponent(file.name)}`);
          xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round(100 * e.loaded / e.total)); };
          xhr.onload = () => {
            try { const result = JSON.parse(xhr.responseText); if (xhr.status >= 400) reject(new Error(result.error)); else resolve(result); }
            catch { reject(new Error(t("wallpaper.uploadFailed"))); }
          };
          xhr.onerror = () => reject(new Error(t("wallpaper.uploadConnectionFailed")));
          xhr.onabort = () => reject(new Error(t("wallpaper.uploadCancelled")));
          xhr.send(file);
        });
        update({ ...data, paused: false });
        await refresh();
      } finally { setProgress(null); upload.current = null; }
    });
  }
  const visible = useMemo(() => selectWallpapers(library.wallpapers, { query, orientation: p.libraryOrientation, kind: p.libraryKind, sort: p.librarySort, mobile, locale }), [library.wallpapers, query, p.libraryOrientation, p.libraryKind, p.librarySort, mobile, locale]);
  const kindName = (w: WallpaperInfo) => w.kind === "web" ? t("wallpaper.webLocalRendering") : w.kind === "scene" ? (sceneAvailable ? t("wallpaper.sceneLocalHd") : t("wallpaper.sceneLoading")) : w.kind === "unsupported" ? (w.reason || t("wallpaper.unsupported")) : w.kind === "video" ? t("wallpaper.video") : t("wallpaper.image");
  const forms = formCatalog?.id === p.id ? formCatalog.forms : [];
  const selectedForm = forms.find(form => form.id === p.sceneForms[p.id || ""])?.id || "";
  return <section aria-labelledby="appearance-wallpapers-heading" className="wallpaper-settings">
    <div className="wallpaper-toolbar">
      <h3 id="appearance-wallpapers-heading">{t("settingsConfig.appearance.wallpapers")}</h3>
      <button type="button" className="wallpaper-command" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} />{t("wallpaper.import")}</button>
      <button type="button" className="wallpaper-icon" title={t("wallpaper.refreshLibrary")} aria-label={t("wallpaper.refreshLibrary")} disabled={busy} onClick={() => void action(() => refresh())}><RefreshCw size={16} /></button>
      <button type="button" className="wallpaper-icon" title={t("wallpaper.disableWallpaper")} aria-label={t("wallpaper.disableWallpaper")} disabled={!p.id} onClick={() => update({ id: null })}><Power size={16} /></button>
      <input ref={input} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.gif,.avif,.mp4,.webm" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) importFile(file); }} />
    </div>
    <div className="wallpaper-options">
      <WallpaperControls />
      {p.id && p.kind === "scene" && <label>{t("wallpaper.form")}<Select
        aria-label={t("wallpaper.wallpaperForm")}
        disabled={formCatalog?.id !== p.id || !forms.length}
        value={selectedForm}
        onChange={value => {
          const sceneForms = { ...p.sceneForms };
          if (value) sceneForms[p.id!] = value; else delete sceneForms[p.id!];
          update({ sceneForms });
        }}
        options={[
          { value: "", label: formCatalog?.id !== p.id ? t("wallpaper.loadingForms") : t("wallpaper.original") },
          ...forms.map(form => ({ value: form.id, label: form.label
            ? `${t("wallpaper.fixed")} · ${form.label}${form.xray ? " · XRAY" : ""}`
            : form.xray ? t("wallpaper.fixedXRay") : t("wallpaper.fixedBaseImage") })),
        ]}
      /></label>}
      <label><input type="checkbox" checked={p.adaptiveText} onChange={e => update({ adaptiveText: e.target.checked })} />{t("wallpaper.textColors")}</label>
      <Select
        aria-label={t("wallpaper.textColorMode")}
        disabled={!p.adaptiveText}
        value={p.textMode}
        onChange={(nextValue) => update({ textMode: nextValue as WallpaperTextMode })}
        options={[
          { value: "fixed", label: t("wallpaper.fixedColor") },
          { value: "auto", label: t("wallpaper.automaticBlackWhite") },
          { value: "material", label: t("wallpaper.materialColors") },
        ]}
      />
      {p.textMode === "fixed" && <span className="wallpaper-text-color">
        <input type="color" aria-label={t("wallpaper.textColor")} disabled={!p.adaptiveText} value={p.textColor} onChange={e => { setColorDraft(null); update({ textColor: e.target.value }); }} />
        <input type="text" aria-label={t("wallpaper.textColorHex")} disabled={!p.adaptiveText} value={colorInput} maxLength={7} spellCheck={false} onChange={e => setColorDraft(e.target.value)} onBlur={commitColor} onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); commitColor(); }
          if (e.key === "Escape") setColorDraft(null);
        }} />
      </span>}
      <label><input type="checkbox" checked={p.adaptivePalette} onChange={e => update({ adaptivePalette: e.target.checked })} />{t("wallpaper.wallpaperColors")}<span className="wallpaper-palette-swatches" aria-hidden="true"><i /><i /><i /></span></label>
      <label>{t("wallpaper.fit")}<Select
        value={p.fit}
        onChange={(nextValue) => update({ fit: nextValue as "cover" | "contain" })}
        options={[
          { value: "cover", label: t("wallpaper.cover") },
          { value: "contain", label: t("wallpaper.contain") },
        ]}
      /></label>
      <label>{t("wallpaper.brightness")}<input aria-label={t("wallpaper.wallpaperBrightness")} type="range" min="20" max="100" value={p.brightness} onChange={e => update({ brightness: Number(e.target.value) })} /><output>{p.brightness}%</output></label>
      <label>{t("wallpaper.glassOpacity")}<input aria-label={t("wallpaper.glassOpacity")} type="range" min="0" max="100" disabled={p.glass === "clear"} value={p.glassOpacity} onChange={e => update({ glassOpacity: Number(e.target.value) })} /><output>{p.glassOpacity}%</output></label>
    </div>
    {p.id && p.kind !== "web" && <WallpaperCrop key={p.id} />}
    <WallpaperBgmConfig />
    <form className="wallpaper-folder" onSubmit={e => { e.preventDefault(); void action(async () => { await mutate("POST", { folder }); setFolder(""); }); }}>
      <input aria-label={t("wallpaper.serverWallpaperFolder")} placeholder={t("wallpaper.absoluteServerWallpaperFolder")} value={folder} onChange={e => setFolder(e.target.value)} />
      <button className="wallpaper-icon" type="submit" disabled={busy || !folder.trim()} title={t("wallpaper.addFolder")} aria-label={t("wallpaper.addFolder")}><FolderPlus size={17} /></button>
    </form>
    {progress !== null && <div className="wallpaper-progress" role="status"><progress value={progress} max="100" /><span>{progress}%</span><button type="button" onClick={() => upload.current?.abort()}>{t("wallpaper.cancel")}</button></div>}
    {error && <p role="alert" className="wallpaper-warning">{error}</p>}
    <div className="wallpaper-library-heading"><span>{visible.length} / {library.wallpapers.length} {t("wallpaper.items")}</span><input type="search" aria-label={t("wallpaper.searchWallpapers")} placeholder={t("wallpaper.searchWallpapers")} value={query} onChange={e => setQuery(e.target.value)} /></div>
    <div className="wallpaper-library-filters">
      <Select aria-label={t("wallpaper.wallpaperOrientation")} value={p.libraryOrientation} onChange={value => update({ libraryOrientation: value as WallpaperOrientation })} options={[
        { value: "auto", label: t("wallpaper.orientationAuto", { orientation: t(mobile ? "wallpaper.portrait" : "wallpaper.landscape") }) },
        { value: "all", label: t("wallpaper.allOrientations") },
        { value: "landscape", label: t("wallpaper.landscape") }, { value: "portrait", label: t("wallpaper.portrait") },
        { value: "square", label: t("wallpaper.square") }, { value: "unknown", label: t("wallpaper.unknownDimensions") },
      ]} />
      <Select aria-label={t("wallpaper.wallpaperType")} value={p.libraryKind} onChange={value => update({ libraryKind: value as WallpaperKindFilter })} options={[
        { value: "all", label: t("wallpaper.allTypes") }, { value: "image", label: t("wallpaper.images") },
        { value: "video", label: t("wallpaper.videos") }, { value: "scene", label: t("wallpaper.scenes") },
        { value: "web", label: t("wallpaper.web") }, { value: "unsupported", label: t("wallpaper.otherFormats") },
      ]} />
      <Select aria-label={t("wallpaper.wallpaperSorting")} value={p.librarySort} onChange={value => update({ librarySort: value as WallpaperSort })} options={[
        { value: "added-desc", label: t("wallpaper.addedNewestFirst") }, { value: "added-asc", label: t("wallpaper.addedOldestFirst") },
        { value: "modified-desc", label: t("wallpaper.modifiedNewestFirst") }, { value: "modified-asc", label: t("wallpaper.modifiedOldestFirst") },
        { value: "name-asc", label: t("wallpaper.nameAscending") }, { value: "name-desc", label: t("wallpaper.nameDescending") },
      ]} />
    </div>
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
          {w.source === "imported" && <button type="button" className="wallpaper-delete" disabled={busy} title={t("wallpaper.deleteImportedWallpaper")} aria-label={`${t("wallpaper.delete")} ${w.title}`} onClick={() => {
            if (!window.confirm(t("wallpaper.deleteConfirm", { title: w.title }))) return;
            void action(async () => { await mutate("DELETE", { id: w.id }); if (p.id === w.id) update({ id: null }); });
          }}><Trash2 size={14} /></button>}
        </article>;
      })}
    </div>
    {!visible.length && <p className="wallpaper-empty">{busy ? t("wallpaper.loading") : t("wallpaper.noMatchingWallpapers")}</p>}
    <details className="wallpaper-folders"><summary>{t("wallpaper.scannedFolders")} ({library.roots.length})</summary>{library.roots.map(r => <div key={r}>{r}</div>)}{library.warnings.map((w, i) => <div key={i} className="wallpaper-warning">{w}</div>)}</details>
  </section>;
}
