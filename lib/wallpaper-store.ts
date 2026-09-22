import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "./omp/paths";
import type { WallpaperInfo } from "./wallpapers";

export const MAX_WALLPAPER_BYTES = 512 * 1024 * 1024;
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm" };
type Entry = WallpaperInfo & { folder: string; file?: string; thumbnail?: string; resourceFolder?: string; metadata?: Record<string, unknown> };
type Catalog = { entries: Entry[]; roots: string[]; warnings: string[] };
const storeDir = () => path.join(getAgentDir(), "web-wallpapers");
const uploadsDir = () => path.join(storeDir(), "imports");
let cached: { home: string; until: number; value: Promise<Catalog> } | undefined;
export function invalidateWallpapers() { cached = undefined; }
export function wallpaperMime(file: string) { return TYPES[path.extname(file).toLowerCase()]; }
export function isWithin(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export async function safeWallpaperFile(folder: string, relative: string) {
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes("\\")) throw new Error("Invalid wallpaper path");
  const root = await fs.realpath(folder);
  const candidate = path.resolve(root, relative);
  if (!isWithin(root, candidate)) throw new Error("Wallpaper path escapes folder");
  const real = await fs.realpath(candidate);
  if (!isWithin(root, real) || !(await fs.stat(real)).isFile()) throw new Error("Invalid wallpaper file");
  return real;
}
async function readJson(file: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Invalid metadata");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export async function readScenePropertyOverrides(id: string): Promise<Record<string, string | number | boolean>> {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid scene identifier");
  try {
    const value = await readJson(path.join(storeDir(), "scene-properties", `${id}.json`));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 256) throw new Error("Invalid scene property overrides");
    return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "boolean" || typeof v === "number" && Number.isFinite(v) || typeof v === "string" && v.length <= 8192)) as Record<string, string | number | boolean>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
async function configuredRoots(): Promise<string[]> {
  try {
    const value = await readJson(path.join(storeDir(), "folders.json"));
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string" && path.isAbsolute(p)).slice(0, 32) : [];
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
// VDF uses quoted key/value tokens. Decode escapes instead of splitting Windows paths.
export function steamLibraryPaths(vdf: string): string[] {
  const tokens = vdf.match(/"(?:\\.|[^"\\])*"|[{}]/g) || [];
  const result: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] !== '"path"' || !tokens[i + 1].startsWith('"')) continue;
    try { const p = JSON.parse(tokens[++i]); if (typeof p === "string") result.push(p); } catch { /* malformed entry */ }
  }
  return result;
}
async function defaultRoots() {
  if (process.env.OMP_WEB_WALLPAPER_DIRS !== undefined) return process.env.OMP_WEB_WALLPAPER_DIRS.split(path.delimiter).filter(Boolean);
  const steam = process.platform === "win32"
    ? [path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam")]
    : [path.join(homedir(), ".steam/steam"), path.join(homedir(), ".local/share/Steam")];
  const libraries = new Set(steam);
  for (const base of steam) {
    try {
      const file = path.join(base, "steamapps/libraryfolders.vdf");
      if ((await fs.stat(file)).size < 1024 * 1024) for (const item of steamLibraryPaths(await fs.readFile(file, "utf8"))) libraries.add(item);
    } catch { /* Steam is optional */ }
  }
  const roots: string[] = [];
  for (const base of libraries) for (const suffix of ["steamapps/workshop/content/431960", "steamapps/common/wallpaper_engine/projects/myprojects"]) {
    const folder = path.join(base, suffix);
    try { if ((await fs.stat(folder)).isDirectory()) roots.push(folder); } catch { /* not installed */ }
  }
  return roots;
}
export async function addWallpaperRoot(folder: string) {
  if (!path.isAbsolute(folder) || folder.length > 2048) throw new Error("An absolute server folder path is required");
  const real = await fs.realpath(folder);
  if (!(await fs.stat(real)).isDirectory()) throw new Error("Not a directory");
  const roots = await configuredRoots();
  if (!roots.includes(real)) roots.push(real);
  if (roots.length > 32) throw new Error("At most 32 folders");
  await fs.mkdir(storeDir(), { recursive: true });
  const temp = path.join(storeDir(), `folders-${randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(roots, null, 2));
  await fs.rename(temp, path.join(storeDir(), "folders.json"));
  invalidateWallpapers();
}
const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
async function scan(): Promise<Catalog> {
  const roots = [...new Set([...(await defaultRoots()), ...(await configuredRoots())])];
  const entries = new Map<string, Entry>();
  const warnings: string[] = [];
  let visited = 0;
  async function walk(folder: string, depth: number, source: Entry["source"]) {
    if (++visited > 3000) return;
    let files;
    try { files = await fs.readdir(folder, { withFileTypes: true }); } catch { warnings.push(`Cannot read: ${folder}`); return; }
    const project = files.find(f => f.name === "project.json" && f.isFile());
    if (project) {
      try {
        const p = await readJson(await safeWallpaperFile(folder, "project.json"));
        const title = typeof p.title === "string" ? p.title.slice(0, 200) : path.basename(folder);
        const media = typeof p.file === "string" ? p.file.replaceAll("\\", "/") : "";
        const mime = wallpaperMime(media);
        const type = typeof p.type === "string" ? p.type.toLowerCase() : "";
        const kind: Entry["kind"] = type === "scene" ? "scene" : type === "web" ? "web" : (type === "video" || type === "image") && mime ? (mime.startsWith("video/") ? "video" : "image") : "unsupported";
        const file = kind === "video" || kind === "image" ? await safeWallpaperFile(folder, media) : undefined;
        let thumbnail: string | undefined;
        try { if (typeof p.preview === "string" && wallpaperMime(p.preview)?.startsWith("image/")) thumbnail = await safeWallpaperFile(folder, p.preview.replaceAll("\\", "/")); } catch { /* optional preview */ }
        const id = key(path.resolve(folder));
        entries.set(id, { id, title, kind, source, folder, file, thumbnail, preview: !!thumbnail || kind === "image", metadata: p });
      } catch { warnings.push(`Invalid project: ${path.basename(folder)}`); }
      return;
    }
    for (const item of files.slice(0, 3000)) {
      if (item.isSymbolicLink() || item.name.startsWith(".")) continue;
      if (item.isDirectory() && depth > 0) await walk(path.join(folder, item.name), depth - 1, source);
      else if (item.isFile() && wallpaperMime(item.name)) {
        const file = path.join(folder, item.name);
        const id = key(path.resolve(file));
        const kind = wallpaperMime(file).startsWith("video/") ? "video" : "image";
        entries.set(id, { id, title: item.name, kind, source, folder, file, preview: kind === "image" });
      }
    }
  }
  try { await fs.mkdir(uploadsDir(), { recursive: true }); await walk(uploadsDir(), 1, "imported"); } catch { warnings.push("Cannot read imported wallpapers"); }
  for (const root of roots) await walk(root, 2, "folder");
  const projects = new Map<string, Entry>();
  for (const e of entries.values()) if (e.metadata) {
    projects.set(path.basename(e.folder), e);
    if (/^\d+$/.test(String(e.metadata.workshopid))) projects.set(String(e.metadata.workshopid), e);
  }
  function resolvePreset(e: Entry, seen = new Set<Entry>()): void {
    if (!e.metadata?.dependency) return;
    if (seen.has(e) || seen.size >= 8) { e.reason = "Cyclic wallpaper dependency"; return; }
    const dependency = String(e.metadata.dependency);
    const base = /^\d+$/.test(dependency) ? projects.get(dependency) : undefined;
    if (!base) { e.reason = `Missing wallpaper dependency: ${dependency}`; return; }
    resolvePreset(base, new Set(seen).add(e));
    if (base.kind === "unsupported" || base.reason) { e.reason = base.reason || "Unsupported base wallpaper"; return; }
    e.kind = base.kind; e.resourceFolder = base.resourceFolder || base.folder; e.file = base.file;
    e.metadata = { ...base.metadata, preset: { ...(base.metadata?.preset as object || {}), ...(e.metadata.preset as object || {}) } };
  }
  for (const e of entries.values()) resolvePreset(e);
  if (visited > 3000) warnings.push("Folder limit reached (3000); add a more specific folder");
  return { entries: [...entries.values()], roots, warnings };
}
export async function wallpaperCatalog(refresh = false) {
  if (refresh || !cached || cached.home !== storeDir() || cached.until < Date.now()) cached = { home: storeDir(), until: Date.now() + 30_000, value: scan() };
  return cached.value;
}
export async function listWallpapers(refresh = false) {
  const { entries, roots, warnings } = await wallpaperCatalog(refresh);
  return { wallpapers: entries.map(({ id, title, kind, source, preview, reason }) => ({ id, title, kind, source, preview, reason })), roots, warnings };
}
export async function resolveSceneProject(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Wallpaper not found");
  const entry = (await wallpaperCatalog(true)).entries.find(e => e.id === id && e.kind === "scene");
  if (!entry) throw new Error("Scene wallpaper not found");
  const folder = entry.resourceFolder || entry.folder;
  const project = await safeWallpaperFile(folder, "project.json");
  const metadata = entry.metadata || await readJson(project);
  const entryFile = typeof metadata.file === "string" ? metadata.file : "scene.json";
  if (String(metadata.type).toLowerCase() !== "scene" || !/^[\w-]+\.json$/.test(entryFile)) throw new Error("Unsupported scene entry point");
  let file: string;
  try { file = await safeWallpaperFile(folder, entryFile.replace(/\.json$/, ".pkg")); }
  catch { file = await safeWallpaperFile(folder, entryFile); }
  return { project, file, metadata, entryFile };
}
export async function resolveWebProject(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Wallpaper not found");
  const entry = (await wallpaperCatalog()).entries.find(e => e.id === id && e.kind === "web");
  if (!entry?.metadata || typeof entry.metadata.file !== "string" || !/\.html?$/i.test(entry.metadata.file)) throw new Error("Web wallpaper entry point not found");
  const folder = entry.resourceFolder || entry.folder;
  await safeWallpaperFile(folder, entry.metadata.file);
  return { folder, file: entry.metadata.file, metadata: entry.metadata };
}
export function validMediaSignature(b: Buffer, mime: string) {
  if (mime === "image/png") return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (mime === "image/gif") return /^GIF8[79]a$/.test(b.toString("ascii", 0, 6));
  if (mime === "image/webp") return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  if (mime === "video/webm") return b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (mime === "image/avif") return b.toString("ascii", 4, 8) === "ftyp" && /avif|avis/.test(b.toString("ascii", 8, 64));
  if (mime === "video/mp4") return b.toString("ascii", 4, 8) === "ftyp";
  return false;
}
export async function resolveWallpaperMedia(id: string, preview: boolean) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Wallpaper not found");
  let e = (await wallpaperCatalog()).entries.find(e => e.id === id);
  // Route bundles/processes may have independent caches after an upload.
  if (!e) e = (await wallpaperCatalog(true)).entries.find(e => e.id === id);
  const file = e && (preview ? e.thumbnail || (e.kind === "image" ? e.file : undefined) : e.file);
  if (!e || !file) throw new Error("Wallpaper media not found");
  const folder = preview && e.thumbnail ? e.folder : e.resourceFolder || e.folder;
  const safe = await safeWallpaperFile(folder, path.relative(folder, file).split(path.sep).join("/"));
  const handle = await fs.open(safe, "r");
  try {
    const head = Buffer.alloc(64);
    await handle.read(head, 0, head.length, 0);
    const mime = wallpaperMime(safe);
    if (!validMediaSignature(head, mime)) throw new Error("Unsupported media content");
    return { handle, mime, stat: await handle.stat() };
  } catch (error) { await handle.close(); throw error; }
}
export async function importWallpaper(request: Request, name: string) {
  name = path.basename(name.replaceAll("\\", "/")).slice(0, 200);
  if (name.startsWith(".") || /[<>:"|?*\x00-\x1f]/.test(name)) throw new Error("Invalid media filename");
  const mime = wallpaperMime(name);
  if (!mime) throw new Error("Supported: PNG, JPEG, WebP, GIF, AVIF, MP4, WebM");
  if (Number(request.headers.get("content-length")) > MAX_WALLPAPER_BYTES) throw new Error("Maximum upload size: 512 MiB");
  const dir = path.join(uploadsDir(), randomUUID());
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, ".upload");
  const handle = await fs.open(temp, "wx");
  let size = 0;
  const head = Buffer.alloc(64);
  const reader = request.body?.getReader();
  try {
    if (!reader) throw new Error("Empty upload");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_WALLPAPER_BYTES) throw new Error("Maximum upload size: 512 MiB");
      if (size < 64) head.set(value.subarray(0, 64 - size), size);
      let offset = 0;
      while (offset < value.length) offset += (await handle.write(value, offset, value.length - offset)).bytesWritten;
      size += value.length;
    }
    const declared = request.headers.get("content-length");
    if (declared !== null && Number(declared) !== size) throw new Error("Incomplete upload");
    if (!size || !validMediaSignature(head, mime)) throw new Error("File content does not match its media type");
    await handle.close();
    const file = path.join(dir, name);
    await fs.rename(temp, file);
    invalidateWallpapers();
    return { id: key(path.resolve(file)), kind: mime.startsWith("video/") ? "video" : "image" };
  } catch (error) {
    await reader?.cancel().catch(() => {});
    await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
    throw error;
  } finally { reader?.releaseLock(); }
}
export async function deleteWallpaper(id: string) {
  const e = (await wallpaperCatalog(true)).entries.find(e => e.id === id && e.source === "imported");
  if (!e?.file || !isWithin(uploadsDir(), e.folder)) throw new Error("Only imported wallpapers may be deleted");
  const realRoot = await fs.realpath(uploadsDir());
  const realFolder = await fs.realpath(e.folder);
  if (!isWithin(realRoot, realFolder)) throw new Error("Invalid imported path");
  await fs.unlink(await safeWallpaperFile(e.folder, path.basename(e.file)));
  await fs.rmdir(e.folder).catch(() => {});
  invalidateWallpapers();
}
export function mediaRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) throw new Error("Invalid range");
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start < 0 || end < start || (!match[1] && Number(match[2]) === 0)) throw new Error("Invalid range");
  return { start, end };
}
