export class WallpaperReader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset) throw new Error("Truncated wallpaper resource");
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  uint() { return this.take(4).readUInt32LE(); }
  int() { return this.take(4).readInt32LE(); }
  float() { return this.take(4).readFloatLE(); }
  string() {
    const length = this.uint();
    if (length > 4096) throw new Error("Wallpaper resource name too long");
    return this.take(length).toString("utf8");
  }
  magic() {
    const result = this.take(9);
    if (result[8] !== 0) throw new Error("Invalid wallpaper resource header");
    return result.toString("ascii", 0, 8);
  }
}

export function resourceName(name: string) {
  if (!name || name.length > 1024 || name.includes("\\") || name.includes(":") || /[\x00-\x1f]/.test(name) || name.split("/").some(p => !p || p === "." || p === "..")) throw new Error("Invalid scene resource path");
  return name;
}

// PKGV directory layout: https://github.com/notscuffed/repkg (format reference).
export function readWallpaperPackage(bytes: Buffer) {
  const r = new WallpaperReader(bytes);
  const header = /^PKGV(\d{4})$/.exec(r.string());
  if (!header || Number(header[1]) < 1 || Number(header[1]) > 23) throw new Error("Unsupported scene package version");
  const count = r.uint();
  if (count > 20000) throw new Error("Too many scene resources");
  const entries = Array.from({ length: count }, () => ({ name: resourceName(r.string()), offset: r.uint(), size: r.uint() }));
  const base = r.offset;
  const result = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.offset + e.size > bytes.length - base || result.has(e.name)) throw new Error("Invalid scene package directory");
    result.set(e.name, bytes.subarray(base + e.offset, base + e.offset + e.size));
  }
  return result;
}
