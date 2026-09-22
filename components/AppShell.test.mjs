import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("generation speed inherits topbar glass instead of a solid chip", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /aria-label=\{speedTitle\}\s+className="shell-metric-pill shell-pill-extra wallpaper-inset"/);
});

test("sidebar drag scales pointer deltas by the interface zoom", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  // clientX is viewport pixels while --sidebar-width is zoomed layout pixels;
  // without the correction the edge overshoots at 110/120% scale.
  assert.match(source, /--ui-scale/);
  assert.match(source, /\(ev\.clientX - startX\) \/ uiScale/);
});

test("topbar title uses only remaining inline space and toolbar measurements account for zoom", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const center = css.match(/\.shell-topbar-center\s*\{([^}]+)\}/)?.[1];
  assert.match(center, /flex:\s*1 1 0/);
  assert.doesNotMatch(center, /position:\s*absolute|translateX|520px/);
  assert.match(source, /maxWidth: "min\(400px, 100%\)"/);
  assert.match(source, /header\.getBoundingClientRect\(\)\.width \/ header\.offsetWidth/);
  assert.match(source, /child\.getBoundingClientRect\(\)\.width \/ scale/);
  assert.match(source, /content\.style\.width = "max-content"/);
  assert.match(source, /content\.style\.width = width/);
});
