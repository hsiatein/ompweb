import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { MessageView } = await jiti.import("./MessageView.tsx");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const sid = "550e8400-e29b-41d4-a716-446655440000";

test("file URLs and parent links open the resolved file and retain a session-authorized browser fallback", () => {
  const opened = [];
  render(React.createElement(MarkdownBody, { cwd: "/work/project", sourceSessionId: sid, onOpenFile: path => opened.push(path) },
    "[external](file:///tmp/report%23one.txt) [parent](../notes.md) [artifact](artifact://36) [bad](javascript:alert%281%29)"));
  for (const name of ["external", "parent", "artifact"]) fireEvent.click(screen.getByRole("link", { name }));
  assert.deepEqual(opened, ["/tmp/report#one.txt", "/work/notes.md", "artifact://36"]);
  const external = screen.getByRole("link", { name: "external" });
  assert.equal(external.getAttribute("href"), `/api/files/tmp/report%23one.txt?type=read&sessionId=${sid}`);
  fireEvent.click(external, { ctrlKey: true });
  assert.equal(opened.length, 3, "modified clicks keep the authorized real href rather than opening a file tab");
  assert.equal(document.querySelector('a[href^="javascript:"]'), null);
});

test("assistant image URLs preserve the originating session across memoized message updates", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "![generated](file:///tmp/picture%20%23%3F.webp)" }] };
  const view = render(React.createElement(MessageView, { message, sessionId: sid }));
  assert.equal(screen.getByAltText("generated").getAttribute("src"), `/api/files/tmp/picture%20%23%3F.webp?type=read&sessionId=${sid}`);
  const other = "550e8400-e29b-41d4-a716-446655440001";
  view.rerender(React.createElement(MessageView, { message, sessionId: other }));
  assert.equal(new URL(screen.getByAltText("generated").src).searchParams.get("sessionId"), other);
});

test("failed local images show the server reason and an old failure cannot replace a newer image", async () => {
  const pending = [];
  // MarkdownBody also loads the home directory (for `~/` links); only image probes are held.
  globalThis.fetch = (url, options) => String(url) === "/api/home"
    ? Promise.resolve(Response.json({ home: "/home/me" }))
    : new Promise(resolve => pending.push({ resolve, options }));
  const view = render(React.createElement(MarkdownBody, { sourceSessionId: sid }, "![old](/tmp/old.png)"));
  fireEvent.error(screen.getByAltText("old"));
  view.rerender(React.createElement(MarkdownBody, { sourceSessionId: sid }, "![new](/tmp/new.png)"));
  await act(async () => pending[0].resolve(Response.json({ code: "access_denied" }, { status: 403 })));
  assert.equal(screen.queryByRole("alert"), null);
  fireEvent.error(screen.getByAltText("new"));
  await act(async () => pending[1].resolve(Response.json({ code: "image_too_large" }, { status: 413 })));
  await waitFor(() => assert.match(screen.getByRole("alert").textContent, /10MB/));
  assert.equal(screen.getByRole("link").hasAttribute("download"), true);
});
