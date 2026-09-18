import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { PetCompanion } = await jiti.import("./PetCompanion.tsx");
const { PetSprite } = await jiti.import("./PetSprite.tsx");
const pet = { key: "codex-test", id: "test", displayName: "Test", spriteVersionNumber: 2, source: "codex", assetUrl: "/api/pets/test/sprite" };
const originalFetch = globalThis.fetch;
beforeEach(() => {
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = async () => Response.json({ pets: [pet], skipped: 0 });
  localStorage.setItem("omp-web:pet", JSON.stringify({ key: pet.key, enabled: true, size: 128 }));
});
afterEach(() => { cleanup(); localStorage.clear(); globalThis.fetch = originalFetch; delete window.matchMedia; });

test("live activity changes select task rows without starting another agent request", async () => {
  const view = render(React.createElement(PetCompanion, { activity: { sessionKey: "a", state: "running" }, onSettings() {} }));
  await waitFor(() => assert.equal(screen.getByRole("img", { name: "Test" }).dataset.petRow, "7"));
  view.rerender(React.createElement(PetCompanion, { activity: { sessionKey: "a", state: "waiting" }, onSettings() {} }));
  assert.equal(screen.getByRole("img", { name: "Test" }).dataset.petRow, "6");
  view.rerender(React.createElement(PetCompanion, { activity: { sessionKey: "a", state: "failed" }, onSettings() {} }));
  assert.equal(screen.getByRole("img", { name: "Test" }).dataset.petRow, "5");
  view.rerender(React.createElement(PetCompanion, { activity: { sessionKey: "b", state: "idle" }, onSettings() {} }));
  assert.equal(screen.getByRole("img", { name: "Test" }).dataset.petRow, "0");
});

test("hide persists and remounts hidden; keyboard movement is clamped in preferences", async () => {
  const view = render(React.createElement(PetCompanion, { activity: { sessionKey: "a", state: "idle" }, onSettings() {} }));
  await screen.findByRole("img", { name: "Test" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Test" }), { key: "ArrowRight" });
  assert.equal(JSON.parse(localStorage.getItem("omp-web:pet")).x, 1);
  fireEvent.click(screen.getByRole("button", { name: "Hide pet" }));
  assert.equal(screen.queryByTestId("pet-companion"), null);
  view.unmount();
  render(React.createElement(PetCompanion, { activity: { sessionKey: "b", state: "running" }, onSettings() {} }));
  assert.equal(screen.queryByTestId("pet-companion"), null);
});

test("sprite animation advances and reduced motion preserves the selected state's first frame", async () => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const view = render(React.createElement(PetSprite, { pet, state: "running" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 170)); });
  assert.notEqual(screen.getByRole("img", { name: "Test" }).dataset.petColumn, "0");
  view.unmount();
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  render(React.createElement(PetSprite, { pet, state: "review", look: { row: 10, column: 4 } }));
  assert.equal(screen.getByRole("img", { name: "Test" }).dataset.petRow, "8");
  assert.equal(screen.getByRole("img", { name: "Test" }).dataset.petColumn, "0");
});
