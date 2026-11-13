import assert from "node:assert/strict";
import "../tests/setup-dom.mjs";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView, SafeMarkdownBody, TaskResultPanel, isInterruptedMessage } = await jiti.import("./MessageView.tsx");
const { CodeBlock } = await jiti.import("./MermaidBlock.tsx");
afterEach(cleanup);

test("custom and compaction messages expose glass surfaces without losing their content", async (t) => {
  let copied;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { copied = text; } } });
  t.after(() => { delete navigator.clipboard; });
  const content = "2 background jobs have completed.\n\nJob bg_15: done.";
  const view = render(React.createElement(MessageView, { message: {
    role: "custom", customType: "async-result", display: true, content, details: { jobs: 2 },
  } }));
  assert.ok(view.container.querySelector(".message-custom.wallpaper-surface"));
  fireEvent.click(view.getByRole("button", { name: "async-result" }));
  fireEvent.click(view.getByRole("button", { name: "Show details" }));
  assert.equal(view.container.querySelector("pre").textContent, content);
  assert.deepEqual(JSON.parse(view.container.querySelector(".message-custom > pre").textContent), { jobs: 2 });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Copy", exact: true })); });
  assert.equal(copied, content);
  fireEvent.click(view.getByRole("button", { name: "Hide details" }));
  assert.equal(view.container.querySelector(".message-custom > pre"), null);
  view.rerender(React.createElement(MessageView, { message: {
    role: "custom", customType: "compaction", content: "Summary retained.", details: { tokensBefore: 1000, tokensAfter: 400 },
  } }));
  assert.ok(view.container.querySelector(".message-compaction.wallpaper-surface"));
  // The model-oriented summary starts folded; the header still shows the event and its size.
  assert.doesNotMatch(view.container.textContent, /Summary retained/);
  assert.match(view.container.textContent, /1k → 400 tokens/);
  fireEvent.click(view.getByRole("button", { name: /Conversation compacted/ }));
  assert.match(view.container.textContent, /Summary retained/);
});

test("hidden extension glass survives expand, details and collapse", () => {
  const view = render(React.createElement(MessageView, { message: {
    role: "custom", customType: "extension_debug", display: false,
    content: "<note>Extension content.</note>", details: { state: "ready" },
  } }));
  const toggle = view.container.querySelector(".message-hidden-toggle.wallpaper-surface");
  assert.ok(toggle);
  assert.equal(view.container.textContent.includes("Extension content."), false);
  assert.equal(view.queryByRole("button", { name: "Show details" }), null);
  fireEvent.click(toggle);
  assert.ok(view.container.querySelector(".message-hidden-content.wallpaper-surface"));
  fireEvent.click(view.getByRole("button", { name: "Show details" }));
  assert.deepEqual(JSON.parse(view.container.querySelector("pre").textContent), { state: "ready" });
  fireEvent.click(toggle);
  assert.equal(view.container.querySelector(".message-hidden-content"), null);
});

test("standalone shell executions have their own glass surface", () => {
  const view = render(React.createElement(MessageView, { message: {
    role: "bashExecution", command: "echo ready", output: "ready", exitCode: 0,
  } }));
  assert.ok(view.container.querySelector(".message-execution.wallpaper-surface"));
  assert.match(view.container.textContent, /echo ready/);
});

test("expanded thinking uses an inset surface and retains whitespace and streaming updates", () => {
  const props = thinking => ({
    message: { role: "assistant", content: [{ type: "thinking", thinking }] },
    isStreaming: true,
  });
  const first = "Preview text\n    indented line";
  const view = render(React.createElement(MessageView, props(first)));
  fireEvent.click(view.container.querySelector(".activity-row-trigger"));
  const output = () => view.container.querySelector(".thinking-output");
  assert.ok(output().classList.contains("wallpaper-inset"));
  assert.equal(output().textContent, first);
  assert.equal(output().getAttribute("data-wallpaper-contrast"), null);
  view.rerender(React.createElement(MessageView, props(first + "\nNew output")));
  assert.equal(output().textContent, first + "\nNew output");
  fireEvent.click(view.container.querySelector(".activity-row-trigger"));
  assert.equal(output(), null);
});

test("deferred thinking errors preserve semantic ink on the glass inset", () => {
  const view = render(React.createElement(MessageView, {
    message: { role: "assistant", content: [{ type: "thinking", thinking: "", deferred: true }] },
  }));
  fireEvent.click(view.container.querySelector(".activity-row-trigger"));
  const output = view.container.querySelector(".thinking-output-error");
  assert.ok(output.classList.contains("wallpaper-inset"));
  assert.equal(output.getAttribute("data-wallpaper-contrast"), "off");
});

test("sent messages without timestamps or branch metadata still offer copy", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: { role: "user", content: "Keep this message copyable." },
  }));
  assert.match(html, /<button[^>]*aria-label="Copy message"/);
});

// Plain Copy needs the browser's layout-aware innerText (not implemented by
// jsdom). Verify code gutters, math, tables, images and spacing in Chromium;
// do not substitute textContent and claim equivalent coverage here.
test("message Markdown copy preserves source, excludes activity, and confirms success in Strict Mode", async (t) => {
  let clipboard = "";
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { clipboard = text; } },
  });
  t.after(() => {
    delete navigator.clipboard;
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const source = "# Heading\n\n**Bold** and [link](https://example.com)\n\n```js\n  code();\n```";
  const messages = [
    { role: "user", content: source },
    { role: "assistant", content: [
      { type: "text", text: source },
      { type: "thinking", thinking: "Do not copy thinking" },
      { type: "toolCall", toolCallId: "copy-tool", toolName: "read", input: { path: "not copied" } },
      { type: "text", text: "## Conclusion\n\nDone." },
    ] },
  ];
  for (const message of messages) {
    const view = render(React.createElement(React.StrictMode, null, React.createElement(MessageView, { message })));
    const button = view.getByRole("button", { name: "Copy as Markdown" });
    await act(async () => { fireEvent.click(button); });
    assert.equal(clipboard, message.role === "user" ? source : `${source}\n\n## Conclusion\n\nDone.`);
    // The click handler's copy chain (clipboard write -> setCopied) resolves on a
    // microtask that can land AFTER act's flush under load, leaving the "Copied"
    // label uncommitted when this line reads the DOM. waitFor lets React commit
    // instead of racing the scheduler (flaked under parallel suite load).
    await waitFor(() => assert.equal(button.textContent, "Copied"));
    view.unmount();
  }
});

test("plain Copy keeps full oversized message source instead of the reveal control", async (t) => {
  let clipboard = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { clipboard = text; } },
  });
  t.after(() => { delete navigator.clipboard; });
  const source = "# Keep the full raw source\n\n".repeat(5000);
  for (const message of [
    { role: "user", content: source },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Do not copy thinking" },
      { type: "text", text: source },
    ] },
  ]) {
    const view = render(React.createElement(MessageView, { message }));
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Copy message" })); });
    assert.equal(clipboard, source);
    view.unmount();
  }
});

test("expanded oversized user message can be collapsed again", (t) => {
  // Layout stub: capped bubbles overflow; an uncapped bubble fits its content.
  const observers = [];
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() {}
  };
  const proto = window.HTMLElement.prototype;
  const scrollHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  const clientHeight = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 1000; } });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get() { return this.style.maxHeight === "none" ? 1000 : 300; },
  });
  t.after(() => {
    globalThis.ResizeObserver = originalResizeObserver;
    for (const [name, descriptor] of [["scrollHeight", scrollHeight], ["clientHeight", clientHeight]]) {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    }
  });

  const view = render(React.createElement(MessageView, { message: { role: "user", content: "long\n\n".repeat(200) } }));
  const resize = () => act(() => { for (const observer of observers) observer.callback([]); });
  fireEvent.click(view.getByRole("button", { name: "Show full input" }));
  resize();
  const toggle = view.getByRole("button", { name: "Collapse input" });
  toggle.focus();
  fireEvent.click(toggle);
  // Before re-measuring, the same toggle must stay mounted and focused.
  assert.equal(document.activeElement, toggle);
  resize();
  assert.equal(view.getByRole("button", { name: "Show full input" }), toggle);
  assert.equal(document.activeElement, toggle);
});

test("expanded grouped tool inputs follow streaming arguments without toggling output", () => {
  const code = "print('first')\nprint('complete')";
  const editInput = { path: "/tmp/example.ts", patch: "-old\n+new", options: { dryRun: false } };
  const toolResults = new Map([["edit-call", {
    role: "toolResult", toolCallId: "edit-call", content: [{ type: "text", text: "Edit complete" }],
  }]]);
  const props = (input) => ({
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    toolResults,
    message: {
      role: "assistant", model: "test", provider: "test",
      content: [
        { type: "toolCall", toolCallId: "eval-call", toolName: "eval", input: { language: "py", code: input } },
        { type: "toolCall", toolCallId: "edit-call", toolName: "edit", input: editInput },
      ],
    },
  });
  const { container, rerender } = render(React.createElement(MessageView, props("print('first')")));
  // Open both tool rows through their disclosure triggers. The collapsible
  // group header is not a row, so only the group-item triggers are clicked.
  const rowTriggers = () => [...container.querySelectorAll("button.activity-group-item-trigger")];
  assert.equal(rowTriggers().length, 2);
  for (const trigger of rowTriggers()) fireEvent.click(trigger);
  const toggles = (label) => [...container.querySelectorAll("button.tool-call-input-toggle")]
    .filter((button) => (button.textContent ?? "").includes(label));
  const inputPanels = () => [...container.querySelectorAll("div.tool-call-input")];
  const pres = (panel) => [...panel.querySelectorAll("pre")];
  assert.equal(toggles("Show full input").length, 2);
  assert.ok(inputPanels().every((panel) => panel.hidden));
  for (const toggle of toggles("Show full input")) fireEvent.click(toggle);
  assert.equal(pres(inputPanels()[0])[1].textContent, "print('first')");
  assert.equal(pres(inputPanels()[1])[1].textContent, editInput.patch);
  assert.deepEqual(JSON.parse(pres(inputPanels()[1])[2].textContent ?? ""), editInput.options);
  rerender(React.createElement(MessageView, props(code)));
  assert.equal(pres(inputPanels()[0])[1].textContent, code);
  const output = () => [...container.querySelectorAll('pre[data-tool-output="true"]')].map((node) => node.textContent);
  assert.deepEqual(output(), ["Edit complete"]);
  for (const toggle of toggles("Collapse input")) fireEvent.click(toggle);
  assert.ok(inputPanels().every((panel) => panel.hidden));
  assert.deepEqual(output(), ["Edit complete"]);
});

test("large message content avoids the markdown pipeline until requested", () => {
  const largeMessage = "x".repeat(100_001);
  const html = renderToStaticMarkup(React.createElement(SafeMarkdownBody, null, largeMessage));

  assert.match(html, /Large message \(100 KB\)/);
  assert.doesNotMatch(html, /markdown-body/);
});

test("streaming code blocks avoid syntax-highlighter line markup", () => {
  const html = renderToStaticMarkup(React.createElement(CodeBlock, {
    code: "const value = 1;",
    lang: "ts",
    isStreaming: true,
  }));

  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /linenumber/);
});

test("MCP mount notices stay out of the transcript", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "xdev-mount-notice",
      content: "The xd:// device inventory changed.",
      display: false,
    },
  }));

  assert.equal(html, "");
});

test("streaming tool calls start collapsed when the interface preference is enabled", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
  }));

  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<pre/);
});

test("expanded tool calls show the compact command header", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
  }));

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /tool-call-details/);
  assert.match(html, /\$<\/span><code>read foo\.ts<\/code>/);
});

test("ask tool previews question prompts instead of object coercion", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        toolCallId: "call-ask",
        toolName: "ask",
        input: {
          questions: [
            { header: "Color", question: "Which color do you prefer?", options: [{ label: "Blue" }], multiSelect: false },
            { header: "Features", question: "Which features should be enabled?", options: [{ label: "Search" }], multiSelect: true },
          ],
        },
      }],
    },
  }));

  assert.match(html, /Color: Which color do you prefer\?/);
  assert.match(html, /Features: Which features should be enabled\?/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("expanded read output uses compact terminal text without line gutters", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "foo.ts" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "1: const value = 1;\\n2: return value;" }] },
    ]]),
  }));

  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /const value = 1;/);
  assert.doesNotMatch(html, /1: const value/);
});

test("tool operations render as compact timeline rows", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      timestamp: 1000,
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "npm test" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", content: [], timestamp: 3000 },
    ]]),
  }));

  assert.match(html, /data-activity-operation="true"/);
  assert.match(html, /activity-row-indicator/);
  assert.match(html, /activity-row-duration/);
  assert.doesNotMatch(html, /border-radius:7px/);
});
test("task tool results render a per-subagent summary panel", () => {
  const html = renderToStaticMarkup(React.createElement(TaskResultPanel, {
    details: {
      totalDurationMs: 360000,
      async: { state: "completed", jobId: "Scout", type: "task" },
      results: [
        { id: "Scout", agent: "scout", task: "Map the surface", exitCode: 0, tokens: 999000, cost: 1.25, durationMs: 360000, resolvedModel: "provider/gpt-5.6:medium" },
        { id: "Worker", agent: "worker", task: "Write the code", exitCode: 1, error: "Test failed", tokens: 500 },
      ],
    },
  }));

  assert.match(html, /Subagents/);
  assert.match(html, /Map the surface/);
  assert.match(html, /Write the code/);
  assert.match(html, /2 subagents/);
  assert.match(html, /999k tok/);
  assert.match(html, /gpt-5.6/);
  assert.match(html, /\u23a4|⤴/);
});

test("task panel renders nothing without task details", () => {
  assert.equal(renderToStaticMarkup(React.createElement(TaskResultPanel, { details: undefined })), "");
  assert.equal(renderToStaticMarkup(React.createElement(TaskResultPanel, { details: { patch: "p" } })), "");
});

test("async-only task details render the job as one started row", () => {
  const html = renderToStaticMarkup(React.createElement(TaskResultPanel, {
    details: { async: { state: "running", jobId: "AsyncAudit", type: "task" } },
  }));
  assert.match(html, /1 subagent/);
  assert.match(html, /AsyncAudit/);
  assert.doesNotMatch(html, /0 subagents/);
});

test("irc:incoming custom messages title with the sender name", () => {
  const view = render(React.createElement(MessageView, {
    message: {
      role: "custom",
      customType: "irc:incoming",
      content: "<irc>\nIncoming IRC message from agent `AuditUiComponents`:\n\nPlease review the current tree.\nThanks.",
      display: true,
    },
  }));
  assert.equal(view.container.textContent.includes("AuditUiComponents"), true);
  assert.equal(view.container.textContent.includes("Please review the current tree"), false);
  fireEvent.click(view.getByRole("button", { name: /AuditUiComponents/ }));
  assert.equal(view.container.textContent.includes("Please review the current tree"), true);
  assert.equal(view.container.textContent.includes("Incoming IRC message from agent"), false);
});

test("hub send renders as an IRC row with the steered message", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-hub-1", toolName: "hub", input: { op: "send", to: "VisualFix", message: "Please ensure the readout path is fixed.\nThanks." } }],
    },
    toolResults: new Map([[
      "call-hub-1",
      {
        role: "toolResult",
        toolCallId: "call-hub-1",
        toolName: "hub",
        content: [{ type: "text", text: "Delivered to 1 peer(s):\n- VisualFix: injected" }],
        details: { op: "send", to: ["VisualFix"], receipts: [{ to: "VisualFix", outcome: "injected" }] },
      },
    ]]),
  }));

  assert.match(html, /IRC → VisualFix injected/);
  assert.match(html, /Please ensure the readout path is fixed/);
  assert.doesNotMatch(html, /Delivered to 1 peer/);
});

test("hub jobs renders the waiting roster instead of raw markdown", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-hub-2", toolName: "hub", input: { op: "jobs" } }],
    },
    toolResults: new Map([[
      "call-hub-2",
      {
        role: "toolResult",
        toolCallId: "call-hub-2",
        toolName: "hub",
        content: [{ type: "text", text: "## Still Running (2)\n\n- `VisualFix` [task]" }],
        details: {
          op: "jobs",
          jobs: [
            { id: "VisualFix", type: "task", status: "running", label: "VisualFix", durationMs: 1890000 },
            { id: "VisualTrace", type: "task", status: "running", label: "VisualTrace", durationMs: 1890000 },
          ],
        },
      },
    ]]),
  }));

  assert.match(html, /waiting on 2 jobs/);
  assert.match(html, /VisualTrace/);
  assert.match(html, /31m30s/);
  assert.doesNotMatch(html, /Still Running/);
});

test("hub jobs without structured details keeps the raw result", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-hub-3", toolName: "hub", input: { op: "jobs" } }],
    },
    toolResults: new Map([[
      "call-hub-3",
      {
        role: "toolResult",
        toolCallId: "call-hub-3",
        toolName: "hub",
        content: [{ type: "text", text: "## Still Running (1)" }],
      },
    ]]),
  }));

  assert.match(html, /Still Running/);
});


test("custom notices hide all content and actions until their header is expanded", () => {
  const output = "Background job bg_1 has completed.\n/root/repo\n---\n    indented output\n".repeat(5);
  const message = {
    role: "custom", customType: "async-result", display: true,
    content: `<system-notice>\n${output}</system-notice>`, details: { result: "private detail" },
  };
  const view = render(React.createElement(MessageView, { message }));
  assert.equal(view.container.textContent, "async-result");
  assert.equal(view.queryByRole("button", { name: "Copy", exact: true }), null);
  assert.equal(view.queryByRole("button", { name: "Show details" }), null);
  fireEvent.click(view.getByRole("button", { name: "async-result" }));
  assert.equal(view.container.querySelector("pre").textContent, output.trim());
  assert.equal(view.container.querySelector("h2"), null);
  view.rerender(React.createElement(MessageView, { message: {
    ...message, content: `<system-notice>\n${output}Final result\n</system-notice>`,
  } }));
  assert.equal(view.container.querySelector("pre").textContent, `${output}Final result`);
  const toggle = view.getByRole("button", { name: "async-result" });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  fireEvent.click(view.getByRole("button", { name: "Show details" }));
  assert.equal(view.container.textContent.includes("private detail"), true);
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(view.container.querySelector("pre"), null);
  assert.equal(view.container.textContent, "async-result");
  assert.equal(view.queryByRole("button", { name: "Copy", exact: true }), null);
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(view.container.querySelector("pre").textContent, `${output}Final result`);
});

for (const customType of ["lsp-late-diagnostic", "advisor", "extension_debug", "future-notice"]) {
  test(`${customType} starts fully folded and preserves the manual choice during updates`, () => {
    const message = {
      role: "custom", customType, display: true,
      content: [{ type: "text", text: "Notice body\n    precise indentation" },
        { type: "image", data: "QUJD", mimeType: "image/png" }],
    };
    const view = render(React.createElement(MessageView, { message }));
    const header = view.getByRole("button");
    assert.equal(header.getAttribute("aria-expanded"), "false");
    assert.equal(view.container.textContent.includes("Notice body"), false);
    assert.equal(view.container.querySelector("img"), null);
    view.rerender(React.createElement(MessageView, { message: { ...message, content: "Updated body" } }));
    assert.equal(view.container.textContent.includes("Updated body"), false);
    fireEvent.click(header);
    assert.equal(header.getAttribute("aria-expanded"), "true");
    assert.equal(view.container.textContent.includes("Updated body"), true);
    view.rerender(React.createElement(MessageView, { message }));
    assert.equal(header.getAttribute("aria-expanded"), "true");
    assert.equal(view.container.querySelector("img").getAttribute("src"), "data:image/png;base64,QUJD");
    if (customType === "lsp-late-diagnostic") {
      assert.equal(view.container.querySelector("pre").textContent, "Notice body\n    precise indentation");
    }
    fireEvent.click(header);
    assert.equal(view.container.textContent.includes("Notice body"), false);
    assert.equal(view.container.querySelector("img"), null);
  });
}


test("a running tool call shows a spinner instead of the no-result marker", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], partial: true },
    ]]),
  }));

  assert.match(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /lucide-check/);
  assert.doesNotMatch(html, /lucide-circle-slash/);
});

test("a running tool with no output yet says so instead of reporting no output", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], partial: true },
    ]]),
  }));

  assert.match(html, /data-tool-running="true"/);
  assert.doesNotMatch(html, /No output/);
});

test("a running tool streams its output before the result is committed", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "line-1\nline-2" }], partial: true },
    ]]),
  }));

  assert.match(html, /data-tool-output="true"/);
  assert.match(html, /line-1/);
  assert.match(html, /line-2/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
});

test("a committed tool result replaces the running affordances", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "long-job" } }],
    },
    toolResults: new Map([[
      "call-1",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "done" }], timestamp: 3000 },
    ]]),
  }));

  assert.doesNotMatch(html, /activity-row-spinner/);
  assert.doesNotMatch(html, /data-tool-running="true"/);
  assert.match(html, /lucide-check/);
});

test("expanded edit results with a patch render the split diff view", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "call-1", toolName: "edit", input: { path: "demo.ts" } }],
    },
    toolResults: new Map([[
      "call-1",
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "Patch applied" }],
        details: {
          patch: "--- a/demo.ts\n+++ b/demo.ts\n@@ -1,1 +1,2 @@\n const keep = true;\n-dropped const gone = 1;\n+added const here = 2;",
        },
      },
    ]]),
  }));

  // Split diff grid (before/after columns) instead of the raw output <pre>.
  assert.match(html, /grid-template-columns:minmax\(0, ?1fr\) minmax\(0, ?1fr\)/);
  assert.match(html, /added const here = 2;/);
  assert.match(html, /dropped const gone = 1;/);
  assert.doesNotMatch(html, /<pre/);
});

test("consecutive tool calls group into an activity group summary", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "a.ts" } },
        { type: "toolCall", toolCallId: "call-2", toolName: "read", input: { path: "b.ts" } },
        { type: "toolCall", toolCallId: "call-3", toolName: "grep", input: { pattern: "test" } },
      ],
    },
  }));

  assert.match(html, /activity-group/);
  assert.match(html, /Read 2 files and searched 1 time/);
});

test("bash (local) rows count as terminal commands in group summaries", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: true,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "go vet ./..." } },
        { type: "toolCall", toolCallId: "call-2", toolName: "bash (local)", input: { command: "go test ./..." } },
      ],
    },
  }));

  assert.match(html, /Ran 2 commands/);
});

test("todo tool calls render clean status badge with action and task name", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    isStreaming: true,
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", toolCallId: "call-1", toolName: "todo", input: { op: "done", task: "Build redesigned component" } },
      ],
    },
  }));

  assert.match(html, /tool-call-todo-badge/);
  assert.match(html, /Completed/);
  assert.match(html, /Build redesigned component/);
});

test("isInterruptedMessage identifies user interruptions accurately", () => {
  assert.equal(isInterruptedMessage("Interrupted by user"), true);
  assert.equal(isInterruptedMessage("interrupted by user"), true);
  assert.equal(isInterruptedMessage("Interrupted"), true);
  assert.equal(isInterruptedMessage("Request aborted"), true);
  assert.equal(isInterruptedMessage("Aborted"), true);
  assert.equal(isInterruptedMessage(null, "aborted"), true);
  assert.equal(isInterruptedMessage("Generation stopped by user"), true);
  assert.equal(isInterruptedMessage("429 Too Many Requests"), false);
  assert.equal(isInterruptedMessage("Provider connection failed"), false);
  assert.equal(isInterruptedMessage(null), false);
});

test("interrupted assistant message renders user-friendly status badge without responseError prefix", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      errorMessage: "Interrupted by user",
      content: [],
    },
  }));

  assert.match(html, /class="wallpaper-inset" role="status"/);
  assert.match(html, /Generation stopped by user/);
  assert.doesNotMatch(html, /messageView\.responseError/);
  assert.doesNotMatch(html, /Response error/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("actual error assistant message renders alert badge without responseError prefix", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      errorMessage: "429 Too Many Requests: Rate limit exceeded",
      content: [],
    },
  }));

  assert.match(html, /class="wallpaper-inset" role="alert"/);
  assert.match(html, /429 Too Many Requests: Rate limit exceeded/);
  assert.doesNotMatch(html, /messageView\.responseError/);
  assert.doesNotMatch(html, /Response error:/);
});

test("interrupted message with partial content renders content before interrupted badge", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    toolCallsDefaultCollapsed: false,
    message: {
      role: "assistant",
      errorMessage: "Interrupted by user",
      content: [
        { type: "text", text: "Partial generated response text" },
      ],
    },
  }));

  const contentIdx = html.indexOf("Partial generated response text");
  const statusIdx = html.indexOf("Generation stopped by user");
  assert.ok(contentIdx !== -1, "partial content must be rendered");
  assert.ok(statusIdx !== -1, "status badge must be rendered");
  assert.ok(contentIdx < statusIdx, "content must precede the interrupted status badge");
});

const FORK_LABEL = "Fork a new session from this point";

test("agent replies offer copy and fork, forking at the turn's user message", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const forked = [];
  const view = render(React.createElement(MessageView, {
    message: { role: "assistant", model: "test", provider: "test", content: [{ type: "text", text: "Done." }] },
    entryId: "assistant-1",
    // Resolved by resolveForkEntryIds: omp's `branch` accepts a user entry only.
    forkEntryId: "user-1",
    onFork: (entryId) => forked.push(entryId),
  }));
  assert.ok(view.getByRole("button", { name: "Copy message" }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  assert.deepEqual(forked, ["user-1"]);
  view.unmount();
});

test("agent replies without text still offer the new-session action", () => {
  const html = renderToStaticMarkup(React.createElement(MessageView, {
    message: {
      role: "assistant", model: "test", provider: "test",
      content: [{ type: "toolCall", toolCallId: "tool-1", toolName: "read", input: { path: "a.ts" } }],
    },
    entryId: "assistant-2",
    forkEntryId: "user-1",
    onFork: () => {},
  }));
  assert.doesNotMatch(html, /aria-label="Copy message"/);
  assert.match(html, new RegExp(`aria-label="${FORK_LABEL}"`));
});

test("a streaming reply and an unforkable row keep no fork action", () => {
  const reply = { role: "assistant", model: "test", provider: "test", content: [{ type: "text", text: "Streaming" }] };
  const streaming = renderToStaticMarkup(React.createElement(MessageView, {
    message: reply, entryId: "assistant-3", forkEntryId: "user-1", onFork: () => {}, isStreaming: true,
  }));
  assert.doesNotMatch(streaming, new RegExp(`aria-label="${FORK_LABEL}"`));
  assert.doesNotMatch(streaming, /aria-label="Copy message"/);
  assert.doesNotMatch(streaming, /aria-label="Read aloud"/);

  const noTarget = renderToStaticMarkup(React.createElement(MessageView, {
    message: reply, entryId: "assistant-4", onFork: () => {},
  }));
  assert.doesNotMatch(noTarget, new RegExp(`aria-label="${FORK_LABEL}"`));
});

test("user messages still fork at their own entry", async (t) => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (originalMatchMedia) window.matchMedia = originalMatchMedia;
    else delete window.matchMedia;
  });
  const forked = [];
  const view = render(React.createElement(MessageView, {
    message: { role: "user", content: "Keep this forkable." },
    entryId: "user-7",
    forkEntryId: "user-7",
    onFork: (entryId) => forked.push(entryId),
  }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: FORK_LABEL })); });
  assert.deepEqual(forked, ["user-7"]);
  view.unmount();
});

test("activity file links resolve against the current session workspace in single and grouped rows", () => {
  for (const grouped of [false, true]) {
    const opened = [];
    const props = {
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", toolCallId: "source", toolName: "read", input: { path: "lib/wallpaper-mesh.ts:35-220" } },
          ...(grouped ? [{ type: "toolCall", toolCallId: "internal", toolName: "read", input: { path: "xd://lsp" } }] : []),
        ],
      },
      cwd: "/projects/first",
      toolCallsDefaultCollapsed: false,
      onOpenFile: path => opened.push(path),
    };
    const view = render(React.createElement(MessageView, props));
    const links = () => view.container.querySelectorAll(".activity-file-link");
    fireEvent.click(links()[0]);
    assert.deepEqual(opened, ["/projects/first/lib/wallpaper-mesh.ts"]);
    assert.equal(links().length, 1);
    view.rerender(React.createElement(MessageView, { ...props, cwd: "/projects/second" }));
    fireEvent.keyDown(links()[0], { key: "Enter" });
    assert.deepEqual(opened, ["/projects/first/lib/wallpaper-mesh.ts", "/projects/second/lib/wallpaper-mesh.ts"]);
    view.unmount();
  }
});
