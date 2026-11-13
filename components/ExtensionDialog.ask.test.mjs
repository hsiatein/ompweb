import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react/pure.js";
import userEvent from "@testing-library/user-event";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ExtensionDialog } = await jiti.import("./ExtensionDialog.tsx");

afterEach(cleanup);

const color = {
  id: "color",
  question: "Pick a color",
  header: "Color",
  options: [{ label: "Red" }, { label: "Green", description: "Calm" }, { label: "Blue" }],
  recommended: 1,
};
const size = { id: "size", question: "Pick a size", options: [{ label: "S" }, { label: "M" }] };
const extras = {
  id: "extras",
  question: "Extras?",
  multi: true,
  options: [{ label: "Cheese" }, { label: "Ham" }, { label: "Egg" }],
  recommended: 2,
};

function renderAsk(questions) {
  const responses = [];
  render(React.createElement(ExtensionDialog, {
    request: { type: "extension_ui_request", id: "ask-1", method: "ask", questions },
    onRespond: (_request, response) => responses.push(response),
    attached: true,
  }));
  return responses;
}

test("single-select renders radios with the recommended option marked and preselected; multi renders checkboxes", () => {
  renderAsk([color, extras]);
  const colorGroup = screen.getByRole("group", { name: /Pick a color/ });
  const radios = colorGroup.querySelectorAll('input[type="radio"]');
  assert.equal(radios.length, 3);
  assert.equal(colorGroup.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, true);
  assert.match(screen.getByRole("radio", { name: /Green/ }).closest("label").textContent, /Recommended/);
  assert.equal(screen.getByRole("radio", { name: /Red/ }).checked, false);

  const extrasGroup = screen.getByRole("group", { name: /Extras\?/ });
  assert.equal(extrasGroup.querySelectorAll('input[type="checkbox"]').length, 3);
  assert.equal(extrasGroup.querySelectorAll('input[type="radio"]').length, 0);
  // Multi-select marks its recommendation but does not preselect it.
  assert.match(screen.getByRole("checkbox", { name: /Egg/ }).closest("label").textContent, /Recommended/);
  assert.equal(screen.getByRole("checkbox", { name: /Egg/ }).checked, false);
});

test("Submit stays disabled until every single-select question is answered", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color, size, extras]);
  const submit = screen.getByRole("button", { name: "Submit" });
  assert.equal(submit.disabled, true, "size has no recommendation and no answer yet");
  await user.click(submit);
  assert.deepEqual(responses, []);

  const sizeOther = screen.getByRole("group", { name: /Pick a size/ }).querySelector("textarea");
  await user.type(sizeOther, "   ");
  assert.equal(submit.disabled, true, "blank Other is not an answer");
  await user.clear(sizeOther);
  await user.click(screen.getByRole("radio", { name: "M" }));
  assert.equal(submit.disabled, false, "empty multi-select does not block submit");
});

test("submit sends answers in question order: single choice, multi choices in option order, trimmed Other", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color, extras, size]);
  await user.click(screen.getByRole("checkbox", { name: /Egg/ }));
  await user.click(screen.getByRole("checkbox", { name: /Cheese/ }));
  await user.type(screen.getByRole("group", { name: /Extras\?/ }).querySelector("textarea"), "  pickles  ");
  await user.click(screen.getByRole("radio", { name: "S" }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{
    answers: [
      { id: "color", selectedOptions: ["Green"] },
      { id: "extras", selectedOptions: ["Cheese", "Egg"], customInput: "pickles" },
      { id: "size", selectedOptions: ["S"] },
    ],
  }]);
});

test("single-select Other replaces the radio choice, and picking a radio clears Other", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color]);
  const other = screen.getByRole("group", { name: /Pick a color/ }).querySelector("textarea");
  // Attached panels focus their first field on the next animation frame.
  // Wait for that initial focus before starting a user interaction elsewhere.
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("radio", { name: "Red" })));
  await user.type(other, " Teal ");
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, false);
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: [], customInput: "Teal" }] });

  await user.click(screen.getByRole("radio", { name: "Red" }));
  assert.equal(other.value, "");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses.pop(), { answers: [{ id: "color", selectedOptions: ["Red"] }] });
});

test("Cancel answers cancelled", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  assert.deepEqual(responses, [{ cancelled: true }]);
});

test("attached questions collapse without submitting and preserve answers when reopened", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([color, extras]);
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("radio", { name: "Red" })));
  await user.click(screen.getByRole("radio", { name: "Blue" }));
  await user.click(screen.getByRole("checkbox", { name: "Cheese" }));
  await user.type(screen.getByRole("group", { name: /Extras/ }).querySelector("textarea"), "pickles");
  const toggle = screen.getByRole("button", { expanded: true });
  await user.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.ok(screen.queryByRole("radio") === null);
  assert.ok(screen.queryByRole("button", { name: "Submit" }) === null);
  assert.ok(screen.queryByRole("button", { name: "Cancel" }) === null);
  assert.deepEqual(responses, []);
  await user.keyboard("{Enter}");
  assert.equal(screen.getByRole("radio", { name: "Blue" }).checked, true);
  assert.equal(screen.getByRole("checkbox", { name: "Cheese" }).checked, true);
  assert.equal(screen.getByRole("group", { name: /Extras/ }).querySelector("textarea").value, "pickles");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [
    { id: "color", selectedOptions: ["Blue"] },
    { id: "extras", selectedOptions: ["Cheese"], customInput: "pickles" },
  ] }]);
});

test("a new question reopens a collapsed attached panel with fresh answers", async () => {
  const user = userEvent.setup();
  const request = { type: "extension_ui_request", id: "ask-first", method: "ask", questions: [color] };
  const props = { request, attached: true, onRespond() {} };
  const view = render(React.createElement(ExtensionDialog, props));
  await waitFor(() => assert.ok(document.activeElement === screen.getByRole("radio", { name: "Red" })));
  await user.click(screen.getByRole("radio", { name: "Blue" }));
  await user.click(screen.getByRole("button", { expanded: true }));
  view.rerender(React.createElement(ExtensionDialog, { ...props, request: { ...request, id: "ask-next" } }));
  assert.ok(screen.getByRole("button", { expanded: true }));
  assert.equal(screen.getByRole("radio", { name: /Green/ }).checked, true);
});

test("multi-select options marked checked start checked and submit unless unticked; text-only questions ask for an answer", async () => {
  const user = userEvent.setup();
  const responses = renderAsk([
    { id: "features", question: "Features?", multi: true, options: [{ label: "Star", checked: true }, { label: "Warmup" }, { label: "Delete", checked: true }] },
    { id: "ttl", question: "Days", multi: true, options: [] },
  ]);
  assert.equal(screen.getByRole("checkbox", { name: /Star/ }).checked, true);
  assert.equal(screen.getByRole("checkbox", { name: /Warmup/ }).checked, false);
  assert.ok(screen.getByPlaceholderText("Your answer"));
  await user.click(screen.getByRole("checkbox", { name: /Delete/ }));
  await user.click(screen.getByRole("button", { name: "Submit" }));
  assert.deepEqual(responses, [{ answers: [{ id: "features", selectedOptions: ["Star"] }, { id: "ttl", selectedOptions: [] }] }]);
});
