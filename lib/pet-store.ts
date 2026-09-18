import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "./omp/paths";
import { parsePetManifest, type PetInfo, type PetManifest } from "./pets";

export const MAX_PET_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PET_UPLOAD_BYTES = MAX_PET_IMAGE_BYTES + 64 * 1024;
export type PetRoots = { imported: string; codex: string };
export function petRoots(): PetRoots {
  return {
    imported: path.join(getAgentDir(), "web-pets"),
    codex: process.env.OMP_WEB_CODEX_PETS_DIR || path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "pets"),
  };
}

// Read only PNG IHDR or WebP container dimensions. Browsers decode the raster;
// no model, executable, HTML, or vector content is accepted by this endpoint.
export function petImageMetadata(bytes: Buffer): { width: number; height: number; type: "image/png" | "image/webp" } {
  if (bytes.length > MAX_PET_IMAGE_BYTES) throw new Error("Pet image exceeds 8 MiB");
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: "image/png" };
  }
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) {
    const format = bytes.toString("ascii", 12, 16);
    const chunkSize = bytes.readUInt32LE(16);
    if (chunkSize + 20 > bytes.length) throw new Error("Truncated WebP");
    if (format === "VP8X" && chunkSize >= 10 && !(bytes[20] & 2)) {
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), type: "image/webp" };
    }
    if (format === "VP8 " && chunkSize >= 10 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, type: "image/webp" };
    }
    if (format === "VP8L" && chunkSize >= 5 && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, type: "image/webp" };
    }
  }
  throw new Error("Expected a static PNG or WebP spritesheet");
}

function validateImage(bytes: Buffer, manifest: PetManifest) {
  const metadata = petImageMetadata(bytes);
  if (metadata.width !== 1536 || metadata.height !== (manifest.spriteVersionNumber === 2 ? 2288 : 1872)) {
    throw new Error(`Expected 1536 x ${manifest.spriteVersionNumber === 2 ? 2288 : 1872} spritesheet`);
  }
  return metadata;
}

async function readLimited(file: string, max: number): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("Invalid or oversized pet file");
  return fs.readFile(file);
}

function folderKey(source: "codex" | "imported", folder: string): string {
  return `${source}-${createHash("sha256").update(folder).digest("hex").slice(0, 32)}`;
}

async function folders(roots: PetRoots) {
  const result: Array<{ source: "codex" | "imported"; folder: string; key: string }> = [];
  for (const source of ["imported", "codex"] as const) {
    try {
      const entries = await fs.readdir(roots[source], { withFileTypes: true });
      for (const entry of entries.slice(0, 500)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const folder = path.join(roots[source], entry.name);
        result.push({ source, folder, key: folderKey(source, folder) });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

async function readPet(entry: { source: "codex" | "imported"; folder: string; key: string }) {
  const manifest = parsePetManifest(JSON.parse((await readLimited(path.join(entry.folder, "pet.json"), 16 * 1024)).toString("utf8")));
  const bytes = await readLimited(path.join(entry.folder, manifest.spritesheetPath), MAX_PET_IMAGE_BYTES);
  const metadata = validateImage(bytes, manifest);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const pet: PetInfo = { ...manifest, key: entry.key, source: entry.source, assetUrl: `/api/pets/${entry.key}/sprite?v=${digest.slice(0, 16)}` };
  return { pet, bytes, type: metadata.type, digest };
}

export async function listPets(roots = petRoots()): Promise<{ pets: PetInfo[]; skipped: number }> {
  const pets: PetInfo[] = [];
  let skipped = 0;
  for (const entry of await folders(roots)) {
    try { pets.push((await readPet(entry)).pet); } catch { skipped++; }
  }
  pets.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { pets, skipped };
}

export async function readPetAsset(key: string, roots = petRoots()) {
  const entry = (await folders(roots)).find((item) => item.key === key);
  return entry ? readPet(entry) : null;
}

export async function importPet(manifestValue: unknown, bytes: Buffer, roots = petRoots()): Promise<PetInfo> {
  const manifest = parsePetManifest(manifestValue);
  const metadata = validateImage(bytes, manifest);
  await fs.mkdir(roots.imported, { recursive: true });
  const name = randomUUID();
  const temp = path.join(roots.imported, `.upload-${name}`);
  const target = path.join(roots.imported, name);
  await fs.mkdir(temp);
  try {
    manifest.spritesheetPath = metadata.type === "image/png" ? "spritesheet.png" : "spritesheet.webp";
    await fs.writeFile(path.join(temp, manifest.spritesheetPath), bytes, { flag: "wx" });
    await fs.writeFile(path.join(temp, "pet.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  }
  return (await readPet({ source: "imported", folder: target, key: folderKey("imported", target) })).pet;
}

export async function removePet(key: string, roots = petRoots()): Promise<boolean> {
  if (!/^imported-[a-f0-9]{32}$/.test(key)) throw new Error("Only imported pets can be deleted");
  const entry = (await folders(roots)).find((item) => item.key === key && item.source === "imported");
  if (!entry) return false;
  // Delete only files owned by our importer, never recurse through user folders.
  const pet = await readPet(entry);
  await fs.unlink(path.join(entry.folder, pet.pet.spritesheetPath));
  await fs.unlink(path.join(entry.folder, "pet.json"));
  await fs.rmdir(entry.folder);
  return true;
}

export async function parsePetUpload(request: Request) {
  const length = Number(request.headers.get("content-length"));
  if (length > MAX_PET_UPLOAD_BYTES) throw new Error("Pet upload exceeds 8 MiB");
  if (!request.body) throw new Error("Missing upload");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PET_UPLOAD_BYTES) { await reader.cancel(); throw new Error("Pet upload exceeds 8 MiB"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers.get("content-type") || "" } }).formData();
  const manifest = form.get("manifest");
  const image = form.get("image");
  if (!(manifest instanceof File) || manifest.size > 16 * 1024 || !(image instanceof File)) throw new Error("Choose pet.json and its spritesheet");
  const value = parsePetManifest(JSON.parse(await manifest.text()));
  if (image.name !== value.spritesheetPath) throw new Error("Image filename does not match spritesheetPath");
  return { manifest: value, bytes: Buffer.from(await image.arrayBuffer()) };
}
