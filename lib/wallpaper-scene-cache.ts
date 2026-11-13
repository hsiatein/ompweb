import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { getAgentDir } from "./omp/paths";
import type { BrowserScene } from "./wallpaper-scene-types";

// Bump when compiler output or asset conversion semantics change.
export const SCENE_CACHE_REVISION = 6;
const MAX_MANIFEST = 64 * 1024 * 1024, MAX_RECORD = 2 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const compress = promisify(gzip);
type Stamp = { size: number; mtime: number; ctime: number };
type Dependency = { file: string; stamp: Stamp | null };
type AssetRecord = { stamp: Stamp; gzip?: Stamp };
type RecordData = { revision: number; key: string; id: string; dependencies: Dependency[]; assets: Record<string, AssetRecord>; manifestHash: string; manifestBytes: number };
export type DiskSceneAsset = { directory: string; key: string; stamp: Stamp; gzip?: Stamp };
export type RawBrowserScene = { manifest: BrowserScene; assets: Map<string, Buffer> };
export type PreparedBrowserScene = {
  manifest: BrowserScene; assets: Map<string, Buffer | DiskSceneAsset>;
  cache: "memory" | "disk" | "built" | "uncached";
  dependencies: Dependency[]; directory?: string;
};
type Entry = { value?: PreparedBrowserScene; pending?: Promise<PreparedBrowserScene>; checked: number; used: number };
const stateKey = Symbol.for("ompweb.scene-disk-cache.v1");
const globalState = globalThis as typeof globalThis & { [stateKey]?: { entries: Map<string, Entry>; writes: Promise<unknown>; building: number } };
const state = globalState[stateKey] ??= { entries: new Map(), writes: Promise.resolve(), building: 0 };

export const sceneCacheRoot = () => path.join(getAgentDir(), "web-wallpapers", "scene-cache");
function capacity() {
  const mb = Number(process.env.OMP_WEB_WALLPAPER_CACHE_MB ?? 4096);
  return Number.isFinite(mb) && mb >= 0 && mb <= 65536 ? Math.floor(mb * 1024 * 1024) : 4096 * 1024 * 1024;
}
async function stamp(file: string): Promise<Stamp | null> {
  try {
    const value = await fs.stat(file);
    return { size: value.size, mtime: value.mtimeMs, ctime: value.ctimeMs };
  } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) return null; throw error; }
}
function equal(a: Stamp | null, b: Stamp | null) { return a === null || b === null ? a === b : a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime; }
function validStamp(value: Stamp) { return value && [value.size, value.mtime, value.ctime].every(Number.isFinite) && value.size >= 0; }
async function unchanged(dependencies: Dependency[]) {
  for (const dependency of dependencies) if (!equal(dependency.stamp, await stamp(dependency.file))) return false;
  return true;
}
async function boundedJson(file: string, max: number) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error("Invalid scene cache metadata");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function validDirectory(directory: string, root: string) {
  return path.dirname(directory) === root && !(await fs.lstat(directory)).isSymbolicLink() && (await fs.realpath(directory)) === directory;
}
async function validAssets(value: PreparedBrowserScene) {
  if (!value.directory) return true;
  if (!await validDirectory(value.directory, path.dirname(value.directory))) return false;
  for (const asset of value.assets.values()) {
    if (Buffer.isBuffer(asset)) continue;
    for (const [suffix, expected] of [["", asset.stamp], [".gz", asset.gzip]] as const) {
      if (!expected) continue;
      const file = path.join(asset.directory, asset.key + suffix);
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || !equal(expected, await stamp(file))) return false;
    }
  }
  return true;
}
async function usable(value: PreparedBrowserScene) {
  try { return await unchanged(value.dependencies) && await validAssets(value); } catch { return false; }
}
async function readCache(root: string, key: string, id: string): Promise<PreparedBrowserScene | undefined> {
  try {
    const pointer = await boundedJson(path.join(root, `${key}.json`), 1024);
    if (typeof pointer.generation !== "string" || !new RegExp(`^${key}-[a-f0-9-]{36}$`).test(pointer.generation)) return;
    const directory = path.join(root, pointer.generation);
    if (!await validDirectory(directory, root)) return;
    const record = await boundedJson(path.join(directory, "record.json"), MAX_RECORD) as RecordData;
    if (record.revision !== SCENE_CACHE_REVISION || record.key !== key || record.id !== id || !Array.isArray(record.dependencies) || record.dependencies.length > 2048
      || record.dependencies.some(d => typeof d.file !== "string" || d.file.length > 4096 || !path.isAbsolute(d.file) || d.stamp !== null && !validStamp(d.stamp))
      || !record.assets || Array.isArray(record.assets) || Object.keys(record.assets).length > 768
      || !Number.isSafeInteger(record.manifestBytes) || record.manifestBytes < 1 || record.manifestBytes > MAX_MANIFEST) return;
    if (!await unchanged(record.dependencies)) return;
    const manifestFile = path.join(directory, "manifest.json"), info = await fs.lstat(manifestFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== record.manifestBytes) return;
    const bytes = await fs.readFile(manifestFile);
    if (hash(bytes) !== record.manifestHash) return;
    const manifest = JSON.parse(bytes.toString("utf8")) as BrowserScene;
    if (manifest.version !== 1 || !Array.isArray(manifest.layers) || !Array.isArray(manifest.textures) || !Array.isArray(manifest.particles)) return;
    const assets = new Map<string, DiskSceneAsset>();
    for (const [key, asset] of Object.entries(record.assets)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !validStamp(asset.stamp) || asset.gzip && !validStamp(asset.gzip)) return;
      assets.set(key, { directory, key, ...asset });
    }
    const value: PreparedBrowserScene = { manifest, assets, directory, dependencies: record.dependencies, cache: "disk" };
    if (!await validAssets(value)) return;
    await fs.utimes(directory, new Date(), new Date());
    return value;
  } catch { return; }
}

// Only generated, flat cache directories may be removed. Never follow links.
async function removeGeneration(root: string, name: string) {
  if (!/^(?:\.tmp-)?[a-f0-9]{64}-[a-f0-9-]{36}$/.test(name)) return false;
  const directory = path.join(root, name);
  try {
    if (!await validDirectory(directory, root)) return false;
    const files = await fs.readdir(directory, { withFileTypes: true });
    if (files.some(f => !f.isFile() || !/^(?:record\.json|manifest\.json|[a-f0-9]{64}(?:\.gz)?)$/.test(f.name))) return false;
    for (const file of files) await fs.unlink(path.join(directory, file.name));
    await fs.rmdir(directory); return true;
  } catch { return false; }
}
async function makeRoom(root: string, bytes: number) {
  if (bytes > capacity()) return false;
  const protectedDirectories = new Set([...state.entries.values()].filter(e => e.pending).map(e => e.value?.directory).filter(Boolean));
  const entries: { name: string; used: number; bytes: number }[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:\.tmp-)?[a-f0-9]{64}-[a-f0-9-]{36}$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name), info = await fs.lstat(directory);
    if (entry.name.startsWith(".tmp-") && Date.now() - info.mtimeMs > 3600_000) { await removeGeneration(root, entry.name); continue; }
    let size = 0;
    for (const child of await fs.readdir(directory, { withFileTypes: true })) if (child.isFile()) size += (await fs.lstat(path.join(directory, child.name))).size;
    entries.push({ name: entry.name, used: info.mtimeMs, bytes: size });
  }
  let total = entries.reduce((n, e) => n + e.bytes, 0);
  for (const entry of entries.sort((a, b) => a.used - b.used)) {
    if (total + bytes <= capacity()) break;
    if (!protectedDirectories.has(path.join(root, entry.name)) && !entry.name.startsWith(".tmp-") && await removeGeneration(root, entry.name)) {
      total -= entry.bytes;
      for (const [key, cached] of state.entries) if (!cached.pending && cached.value?.directory === path.join(root, entry.name)) state.entries.delete(key);
    }
  }
  return total + bytes <= capacity();
}
async function persist(root: string, key: string, id: string, compiled: RawBrowserScene, dependencies: Dependency[]) {
  const manifest = Buffer.from(JSON.stringify(compiled.manifest));
  if (manifest.length > MAX_MANIFEST) return;
  const payloads = new Map(compiled.assets);
  for (const font of compiled.manifest.fonts || []) {
    if (/^font\/(ttf|otf)$/.test(font.mimeType)) payloads.set(`${font.key}.gz`, await compress(compiled.assets.get(font.key)!, { level: 3 }));
  }
  const recordBudget = Buffer.byteLength(JSON.stringify(dependencies)) + compiled.assets.size * 512 + 1024;
  if (recordBudget > MAX_RECORD) return;
  const total = [...payloads.values()].reduce((n, b) => n + b.length, manifest.length + recordBudget);
  if (!await makeRoom(root, total)) return;
  const generation = `${key}-${randomUUID()}`, temporary = `.tmp-${generation}`;
  const staging = path.join(root, temporary), directory = path.join(root, generation);
  const pointer = path.join(root, `${generation}.tmp`);
  let published = false;
  try {
    await fs.mkdir(staging, { mode: 0o700 });
    for (const [name, bytes] of payloads) {
      if (!/^[a-f0-9]{64}(?:\.gz)?$/.test(name)) throw new Error("Invalid compiled asset key");
      await fs.writeFile(path.join(staging, name), bytes, { flag: "wx", mode: 0o600 });
    }
    await fs.writeFile(path.join(staging, "manifest.json"), manifest, { flag: "wx", mode: 0o600 });
    await fs.rename(staging, directory);
    const assets: Record<string, AssetRecord> = {};
    for (const asset of compiled.assets.keys()) assets[asset] = { stamp: (await stamp(path.join(directory, asset)))!, ...(payloads.has(`${asset}.gz`) ? { gzip: (await stamp(path.join(directory, `${asset}.gz`)))! } : {}) };
    const record: RecordData = { revision: SCENE_CACHE_REVISION, key, id, dependencies, assets, manifestHash: hash(manifest), manifestBytes: manifest.length };
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json) > MAX_RECORD || !await unchanged(dependencies)) return;
    await fs.writeFile(path.join(directory, "record.json"), json, { flag: "wx", mode: 0o600 });
    await fs.writeFile(pointer, JSON.stringify({ generation }), { flag: "wx", mode: 0o600 });
    await fs.rename(pointer, path.join(root, `${key}.json`)); published = true;
    const value = await readCache(root, key, id);
    if (value) value.cache = "built";
    return value;
  } finally {
    await fs.unlink(pointer).catch(() => {});
    await removeGeneration(root, temporary);
    if (!published) await removeGeneration(root, generation);
  }
}

export async function cachedBrowserScene(id: string, compile: (observe: (file: string) => Promise<void>) => Promise<RawBrowserScene>, validate = false) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid scene identifier");
  const rootPath = sceneCacheRoot();
  const key = hash(JSON.stringify([SCENE_CACHE_REVISION, rootPath, id, process.env.OMP_WEB_WALLPAPER_DIRS, process.env.OMP_WEB_WALLPAPER_ASSETS, process.env.OMP_WEB_WALLPAPER_ENGINE, capacity()]));
  let entry = state.entries.get(key);
  if (entry?.pending) return entry.pending;
  if (!entry) {
    while (state.entries.size >= 8) {
      const candidate = [...state.entries].filter(([, e]) => !e.pending).sort((a, b) => a[1].used - b[1].used)[0];
      if (!candidate) break; state.entries.delete(candidate[0]);
    }
    entry = { checked: 0, used: Date.now() }; state.entries.set(key, entry);
  }
  const current = entry;
  const run = async (): Promise<PreparedBrowserScene> => {
    current.used = Date.now();
    const recent = !validate && Date.now() - current.checked < 2000;
    if (current.value && (recent || await usable(current.value))) {
      if (!recent) current.checked = Date.now();
      if (current.value.directory) await fs.utimes(current.value.directory, new Date(), new Date()).catch(() => {});
      return { ...current.value, cache: current.value.directory ? "memory" : "uncached" };
    }
    current.value = undefined;
    let root: string | undefined;
    if (capacity()) {
      try { await fs.mkdir(rootPath, { recursive: true, mode: 0o700 }); root = await fs.realpath(rootPath); } catch { /* Read-only installations still render. */ }
    }
    if (root) {
      const disk = await readCache(root, key, id);
      if (disk) { current.value = disk; current.checked = Date.now(); return disk; }
    }
    const dependencies = new Map<string, Dependency>();
    const observe = async (file: string) => {
      file = path.resolve(file);
      if (!dependencies.has(file)) {
        if (dependencies.size >= 2048) throw new Error("Too many scene cache dependencies");
        dependencies.set(file, { file, stamp: await stamp(file) });
      }
    };
    await observe(path.join(getAgentDir(), "web-wallpapers", "folders.json"));
    await observe(path.join(getAgentDir(), "web-wallpapers", "scene-properties", `${id}.json`));
    if (state.building >= 2) throw new Error("Two scenes are loading. Please retry after they finish.");
    state.building++;
    try {
      const compiled = await compile(observe), inputs = [...dependencies.values()];
      let prepared: PreparedBrowserScene | undefined;
      if (root && await unchanged(inputs)) {
        const write = state.writes.catch(() => {}).then(() => persist(root!, key, id, compiled, inputs));
        state.writes = write.catch(() => {});
        try { prepared = await write; } catch { /* Full/unwritable cache must not prevent playback. */ }
      }
      current.value = prepared ?? { ...compiled, cache: "uncached", dependencies: inputs };
      current.checked = Date.now();
      // Large uncached scenes retain the previous two-scene memory bound.
      const raw = [...state.entries].filter(([, e]) => e.value && !e.value.directory).sort((a, b) => a[1].used - b[1].used);
      while (raw.length > 2) state.entries.delete(raw.shift()![0]);
      return current.value;
    } finally { state.building--; }
  };
  current.pending = run();
  try { return await current.pending; }
  catch (error) { state.entries.delete(key); throw error; }
  finally { current.pending = undefined; }
}
