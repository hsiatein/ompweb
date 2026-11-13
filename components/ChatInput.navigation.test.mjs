import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ChatInput } = await jiti.import("./ChatInput.tsx");
const { useSidebarHistory } = await jiti.import("@/hooks/useSidebarHistory");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  cleanup();
  clearDraft("new:unassigned");
  clearDraft("draft-a");
  clearDraft("draft-b");
  localStorage.clear();
  delete window.matchMedia;
});

function warnsOnExit() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function Guard() {
  // The actual history protocol is exercised in useSidebarHistory.test.mjs.
  // This mounts the same document guard with the real composer/draft store.
  useSidebarHistory({ active: false, ready: false, sidebarOpen: true, setSidebarOpen() {}, url: "" });
  return null;
}

test("no-key composer text survives minimization and warns on document exit until sent", async () => {
  const user = userEvent.setup();
  const sent = [];
  function Shell({ minimized = false }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Guard),
      React.createElement("div", { style: { display: minimized ? "none" : undefined } },
        React.createElement(ChatInput, { onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false })),
    );
  }
  const { rerender } = render(React.createElement(Shell));
  assert.equal(warnsOnExit(), false);
  await user.type(screen.getByRole("textbox"), "unsent in a new composer");
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { minimized: true }));
  assert.equal(warnsOnExit(), true);
  assert.equal(screen.getByRole("textbox", { hidden: true }).value, "unsent in a new composer");
  rerender(React.createElement(Shell));
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  assert.deepEqual(sent, ["unsent in a new composer"]);
  assert.equal(warnsOnExit(), false);
});

test("attachment-only drafts stay protected across live draft-key changes and restore without warning on internal picks", async () => {
  const user = userEvent.setup();
  const ref = React.createRef();
  const sent = [];
  function Shell({ session }) {
    return React.createElement(React.Fragment, null,
      React.createElement(Guard),
      React.createElement(ChatInput, { draftKey: session, ref, onSend: (text) => sent.push(text), onAbort() {}, isStreaming: false }),
    );
  }
  const { rerender } = render(React.createElement(Shell, { session: "draft-a" }));
  await act(async () => {
    ref.current.addFiles([new File(["important attachment"], "notes.txt", { type: "text/plain" })]);
  });
  await waitFor(() => assert.equal(getDraft("draft-a")?.files[0]?.content, "important attachment"));
  assert.ok(document.querySelector(".composer-file-attachment.wallpaper-surface"));
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { session: "draft-b" }));
  assert.equal(screen.getByRole("textbox").value, "");
  assert.equal(getDraft("draft-a")?.files[0]?.content, "important attachment");
  assert.equal(warnsOnExit(), true);
  rerender(React.createElement(Shell, { session: "draft-a" }));
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  assert.match(sent[0], /important attachment/);
  assert.equal(warnsOnExit(), false);
});

test("attachment errors stay accessible on their glass surface", async () => {
  const ref = React.createRef();
  render(React.createElement(ChatInput, { ref, onSend() {}, onAbort() {}, isStreaming: true }));
  await act(async () => { ref.current.addFiles([new File(["notes"], "notes.txt", { type: "text/plain" })]); });
  const alert = screen.getByRole("alert");
  assert.ok(alert.classList.contains("wallpaper-surface"));
  assert.match(alert.textContent, /Attachments are disabled/);
});

test("left and right move the caret while the slash command menu is open", async () => {
  Element.prototype.scrollIntoView ??= () => {}; // jsdom lacks it; the menu scrolls its active item
  const user = userEvent.setup();
  const sent = [];
  render(React.createElement(ChatInput, {
    onSend: (text) => sent.push(text),
    onAbort() {},
    isStreaming: false,
    slashCommands: [{ name: "skill:h3-video", description: "video", source: "skill" }],
  }));
  const box = screen.getByRole("textbox");
  // Matches a command: the menu is open, but ←/→ still edit the text.
  await user.type(box, "/skill:h3");
  await user.keyboard("{ArrowLeft}{ArrowLeft}X");
  assert.equal(box.value, "/skill:Xh3");
  // Matches nothing (a path): every key edits the text.
  await user.clear(box);
  await user.type(box, "/tmp/x");
  await user.keyboard("{ArrowLeft}{ArrowLeft}Y{ArrowRight}Z");
  assert.equal(box.value, "/tmpY/Zx");
});
