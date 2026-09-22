import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  normalizeFilePathSlashes,
  resolveWorkspaceFilePath,
} = jiti("./file-paths.ts");

test("host file paths resolve against the session workspace, not the filesystem root", () => {
  assert.equal(resolveWorkspaceFilePath("charts/chart.png", "D:\\work\\project"), "D:/work/project/charts/chart.png");
  assert.equal(resolveWorkspaceFilePath("charts\\chart.png", "D:\\work\\project"), "D:/work/project/charts/chart.png");
  assert.equal(resolveWorkspaceFilePath("README", "/srv/project/"), "/srv/project/README");
  assert.equal(resolveWorkspaceFilePath("chart.png", "\\\\nas\\share"), "//nas/share/chart.png");
  assert.equal(resolveWorkspaceFilePath("chart#1%20?.png", "/srv/project"), "/srv/project/chart#1%20?.png");
  assert.equal(resolveWorkspaceFilePath("chart\\1.png", "/srv/project"), "/srv/project/chart\\1.png");
});

test("host file paths retain absolute paths and reject URLs or an unknown workspace", () => {
  assert.equal(resolveWorkspaceFilePath("E:\\images\\chart.png", "D:/work"), "E:/images/chart.png");
  assert.equal(resolveWorkspaceFilePath("/tmp/chart.png", "/srv/project"), "/tmp/chart.png");
  assert.equal(resolveWorkspaceFilePath("\\\\nas\\share\\chart.png"), "//nas/share/chart.png");
  for (const input of ["", "  ", "https://example.test/chart.png", "file:///tmp/chart.png", "D:chart.png", "bad\0path"]) {
    assert.equal(resolveWorkspaceFilePath(input, "D:/work"), null, input);
  }
  assert.equal(resolveWorkspaceFilePath("chart.png"), null);
  assert.equal(resolveWorkspaceFilePath("chart.png", "relative/workspace"), null);
});

test("normalizeFilePathSlashes keeps drive and UNC roots absolute", () => {
  assert.equal(normalizeFilePathSlashes("C:\\Users\\me\\file.txt"), "C:/Users/me/file.txt");
  assert.equal(normalizeFilePathSlashes("\\\\server\\share\\dir"), "//server/share/dir");
  assert.equal(normalizeFilePathSlashes("plain/path"), "plain/path");
});

test("encodeFilePathForApi preserves the UNC prefix through URL segments", () => {
  // `\\\\server\\share\\dir` must round-trip: the route joins the segments and
  // calls isWindowsAbsolutePath, which accepts `//` — so the encoded form must
  // keep the leading `//` folded into the first segment.
  const encoded = encodeFilePathForApi("\\\\server\\share\\dir\\file.txt");
  const segments = encoded.split("/").map(decodeURIComponent);
  assert.equal(segments[0], "//server");
  assert.deepEqual(segments, ["//server", "share", "dir", "file.txt"]);
  // Reconstructing the route's join → isWindowsAbsolutePath check must see UNC.
  const joined = segments.join("/");
  assert.ok(joined.startsWith("//server/share/dir/file.txt"));
});

test("encodeFilePathForApi still encodes ordinary and drive paths", () => {
  assert.equal(encodeFilePathForApi("C:\\Users\\me\\a b.txt"), "C%3A/Users/me/a%20b.txt");
  assert.equal(encodeFilePathForApi("a/b/c.txt"), "a/b/c.txt");
});

test("getFileName and getFileDirectory handle drive and UNC roots", () => {
  assert.equal(getFileName("C:\\Users\\me\\file.txt"), "file.txt");
  assert.equal(getFileDirectory("C:\\Users\\me\\file.txt"), "C:/Users/me");
  assert.equal(getFileName("\\\\server\\share\\dir\\file.txt"), "file.txt");
});
