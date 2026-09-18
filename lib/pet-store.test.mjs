import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { importPet, listPets, readPetAsset, removePet, parsePetUpload, petImageMetadata, MAX_PET_UPLOAD_BYTES } = await jiti.import("./pet-store.ts");
const manifest = { id: "test", displayName: "Test", spritesheetPath: "spritesheet.webp", spriteVersionNumber: 2 };

// Container metadata fixture. Browser decoding is covered using a real atlas
// in the visual/integration checks, not this metadata-only byte sequence.
function webp(version = 2) {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(22, 4); bytes.write("WEBPVP8X", 8); bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(1535, 24, 3); bytes.writeUIntLE(version === 2 ? 2287 : 1871, 27, 3);
  return bytes;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "omp-pets-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { imported: path.join(root, "imported"), codex: path.join(root, "codex") };
}

test("import normalizes filenames, persists outside source, serves exact bytes, and deletes only imported files", async (t) => {
  const roots = await fixture(t);
  const bytes = webp();
  const pet = await importPet(manifest, bytes, roots);
  assert.match(pet.key, /^imported-[a-f0-9]{32}$/);
  const listed = await listPets(roots);
  assert.deepEqual(listed.pets.map((item) => item.key), [pet.key]);
  assert.deepEqual((await readPetAsset(pet.key, roots)).bytes, bytes);
  assert.equal(await readPetAsset("../../anything", roots), null);
  assert.equal(await removePet(pet.key, roots), true);
  assert.equal(await removePet(pet.key, roots), false);
  assert.deepEqual((await listPets(roots)).pets, []);
});

test("local Codex v1 directories may use Unicode names; original pets are never deletable", async (t) => {
  const roots = await fixture(t);
  const folder = path.join(roots.codex, "\u7231\u5f25\u65af");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "pet.json"), JSON.stringify({ ...manifest, spriteVersionNumber: undefined }));
  await fs.writeFile(path.join(folder, "spritesheet.webp"), webp(1));
  const result = await listPets(roots);
  assert.equal(result.pets[0].spriteVersionNumber, 1);
  assert.equal(result.pets[0].source, "codex");
  await assert.rejects(removePet(result.pets[0].key, roots), /Only imported/);
  assert.equal((await listPets(roots)).pets.length, 1);
});

test("invalid version/geometry, external paths, animated containers, and truncated bytes are rejected", async (t) => {
  const roots = await fixture(t);
  await assert.rejects(importPet(manifest, webp(1), roots), /1536 x 2288/);
  await assert.rejects(importPet({ ...manifest, spritesheetPath: "../secret.png" }, webp(), roots));
  const animated = webp(); animated[20] = 2;
  assert.throws(() => petImageMetadata(animated));
  assert.throws(() => petImageMetadata(webp().subarray(0, 25)));
  await assert.rejects(importPet(manifest, Buffer.from("<svg/>"), roots));
  assert.deepEqual((await listPets(roots)).pets, []);
});

test("broken local packages do not hide the rest of the library", async (t) => {
  const roots = await fixture(t);
  const invalid = path.join(roots.codex, "invalid");
  await fs.mkdir(invalid, { recursive: true });
  await fs.writeFile(path.join(invalid, "pet.json"), "{");
  await importPet(manifest, webp(), roots);
  const result = await listPets(roots);
  assert.equal(result.skipped, 1);
  assert.equal(result.pets.length, 1);
});

test("multipart uploads require matching filenames and are bounded even without Content-Length", async () => {
  const form = new FormData();
  form.append("manifest", new File([JSON.stringify(manifest)], "pet.json"));
  form.append("image", new File([webp()], "spritesheet.webp"));
  const result = await parsePetUpload(new Request("http://localhost/api/pets", { method: "POST", body: form }));
  assert.deepEqual(result.bytes, webp());
  form.set("image", new File([webp()], "wrong.webp"));
  await assert.rejects(parsePetUpload(new Request("http://localhost/api/pets", { method: "POST", body: form })), /filename/);
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(MAX_PET_UPLOAD_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(parsePetUpload(new Request("http://localhost/api/pets", { method: "POST", body, duplex: "half" })), /exceeds/);
  assert.equal(cancelled, true);
});
