import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { credentialProviderId, mergeLoginMethods, parseLoginProviders } = await jiti.import("./login-providers.ts");

const provider = (id, name, authenticated = false) => ({ id, name, available: true, authenticated });

test("an alias login method folds into the provider it stores credentials for", () => {
  const merged = mergeLoginMethods([
    provider("openai-codex-device", "ChatGPT (device)", true),
    provider("openai-codex", "ChatGPT", true),
    provider("anthropic", "Claude"),
  ]);
  assert.deepEqual(merged.map((p) => [p.id, p.loginMethods.map((m) => m.id)]), [
    ["openai-codex", ["openai-codex", "openai-codex-device"]],
    ["anthropic", ["anthropic"]],
  ]);
  assert.equal(credentialProviderId("openai-codex-device"), "openai-codex");
  assert.equal(credentialProviderId("anthropic"), "anthropic");
});

test("an alias whose target is missing stays a provider of its own", () => {
  const merged = mergeLoginMethods([provider("zai-coding-plan", "Z.AI sign in")]);
  assert.deepEqual(merged.map((p) => [p.id, p.loginMethods.map((m) => m.id)]), [["zai-coding-plan", ["zai-coding-plan"]]]);
});

test("malformed RPC entries are dropped and availability defaults to true", () => {
  assert.deepEqual(parseLoginProviders([{ id: "a", name: "A", authenticated: false }, { id: 1 }, null, "x"]), [
    { id: "a", name: "A", available: true, authenticated: false },
  ]);
  assert.deepEqual(parseLoginProviders(undefined), []);
});
