import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { contrastRegion } = await jiti.import("./wallpaper-contrast-dom.ts");
const { chooseRegionInk, composite, INK, contrast } = await jiti.import("./wallpaper-contrast.ts");
afterEach(() => document.body.replaceChildren());

function fixture(html) {
  document.body.innerHTML = `<main class="wallpaper-shell">${html}</main>`;
  const root = document.querySelector("main");
  return {
    root,
    find: id => contrastRegion(document.getElementById(id), root, el => Number(el.dataset.alpha || 0)),
  };
}

test("opaque settings panels and cards override the hidden wallpaper", () => {
  const { find } = fixture('<section id="panel" data-alpha="255"><h2 id="heading">Settings</h2><div id="card" data-alpha="255"><label id="label">Option</label><p id="description">Description</p></div></section>');
  assert.equal(find("heading").id, "panel");
  assert.equal(find("label").id, "card");
  assert.equal(find("description").id, "card");
  for (const [wallpaper, fill, expected] of [[[4, 8, 12], [250, 248, 255, 255], "dark"], [[248, 248, 248], [18, 20, 26, 255], "light"]]) {
    const background = composite(wallpaper, fill);
    assert.equal(chooseRegionInk([background]), expected);
    assert.ok(contrast(INK[expected], background) >= 4.5);
  }
});

test("solid controls inside glass form their own region", () => {
  const { find } = fixture('<article class="wallpaper-assistant" id="message"><button id="button" data-alpha="255"><span id="caption">Action</span></button><input id="input" data-alpha="255"><p id="text">Message</p></article>');
  assert.equal(find("caption").id, "button");
  assert.equal(find("input").id, "input");
  assert.equal(find("text").id, "message");
});

test("translucent rows and unfilled controls preserve whole-box ink", () => {
  const { find } = fixture('<article class="wallpaper-assistant" id="message"><table><thead data-alpha="15"><tr><th id="header">Title</th></tr></thead><tbody><tr data-alpha="8"><td id="cell">Value</td></tr></tbody></table><button><span id="action">Copy</span></button></article>');
  for (const id of ["header", "cell", "action"]) assert.equal(find(id).id, "message");
});

test("nested glass on a solid panel is still a separate region", () => {
  const { find } = fixture('<section data-alpha="255"><div id="glass" class="wallpaper-surface"><span id="label">Glass</span></div></section>');
  assert.equal(find("label").id, "glass");
});

test("glass inset controls and badges each share ink within their own bounds", () => {
  const { find } = fixture('<section class="wallpaper-surface"><button id="button" class="wallpaper-inset" data-alpha="26"><span id="caption">New session</span></button><span id="provider" class="wallpaper-inset" data-alpha="26">Provider</span><div class="wallpaper-inset" id="breadcrumb"><span id="project">Project</span><span id="session">Session</span></div></section>');
  assert.equal(find("caption").id, "button");
  assert.equal(find("provider").id, "provider");
  assert.equal(find("project").id, "breadcrumb");
  assert.equal(find("session").id, "breadcrumb");
});

test("fallback is bounded by the contrast root", () => {
  const { find, root } = fixture('<button id="button"><span id="label">Action</span></button><p id="text">Text</p>');
  document.body.dataset.alpha = "255";
  assert.equal(find("label").id, "button");
  assert.equal(find("text"), root);
  delete document.body.dataset.alpha;
});
