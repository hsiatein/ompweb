import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-update-locked-"));
  const bin = join(root, process.platform === "win32" ? "omp.cmd" : "omp");
  const sentinel = join(root, "installer-ran");
  writeFileSync(bin, process.platform === "win32"
    ? '@echo off\r\nif "%~1"=="--version" (echo 18.12.6&exit /b 0)\r\necho called>"%OMP_UPDATE_SENTINEL%"\r\nexit /b 0\r\n'
    : '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "18.12.6\\n"; exit 0; fi\nprintf "called\\n" > "$OMP_UPDATE_SENTINEL"\n', { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, bin, sentinel };
}

test("runtime status reads the local version while keeping official installation unavailable", async (t) => {
  const { bin, sentinel } = fixture(t);
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; });
  process.env.OMP_WEB_OMP_BIN = bin;
  process.env.OMP_UPDATE_SENTINEL = sentinel;
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const { checkOmpUpdate } = await jiti.import("./updates.ts");
  const status = await checkOmpUpdate();
  assert.equal(status.currentVersion, "18.12.6");
  assert.equal(status.updatesDisabled, true);
  assert.equal(status.reason, "source_managed");
  assert.equal(status.updateAvailable, false);
  assert.equal(status.availableVersion, null);
  assert.equal(status.updateCommand, null);
  assert.equal(existsSync(sentinel), false);
});

test("direct OMP worker invocation rejects before launching either installer", (t) => {
  const { root, bin, sentinel } = fixture(t);
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../../bin/omp-web-update-worker.js", import.meta.url)),
    "--kind", "omp", "--attempt", "00000000-0000-4000-8000-000000000001",
    "--root", root, "--package-dir", root, "--target", "99.0.0",
    "--manager-path", bin,
  ], { env: { ...process.env, OMP_WEB_OMP_BIN: bin, OMP_UPDATE_SENTINEL: sentinel }, timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(existsSync(sentinel), false);
  assert.equal(existsSync(join(root, "status.json")), false);
});
