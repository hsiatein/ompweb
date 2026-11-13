import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { addAccountAuthUrl, diffLoginAccounts, loginAccounts } = await jiti.import("./login-accounts.ts");

test("adding an OpenAI account asks for a fresh sign-in and keeps the PKCE request intact", () => {
  const url = "https://auth.openai.com/oauth/authorize?response_type=code&state=s1&code_challenge=c1&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback";
  const added = new URL(addAccountAuthUrl(url));
  assert.equal(added.searchParams.get("prompt"), "login");
  for (const key of ["state", "code_challenge", "redirect_uri"]) assert.equal(added.searchParams.get(key), new URL(url).searchParams.get(key));
  const other = "https://claude.ai/oauth/authorize?state=x";
  assert.equal(addAccountAuthUrl(other), other);
  assert.equal(addAccountAuthUrl("not a url"), "not a url");
});

test("the login outcome names new accounts, or says the browser reused a connected one", () => {
  const report = (provider, accountKey, extra = {}) => ({ provider, accountKey, ...extra });
  const before = loginAccounts([report("openai-codex", "a".repeat(16), { accountLabel: "qq*", plan: "pro" }), report("openai-codex", "a".repeat(16), { pool: "x" })]);
  assert.deepEqual(before, [{ provider: "openai-codex", accountKey: "a".repeat(16), name: "qq*", plan: "pro" }]);
  const added = loginAccounts([report("openai-codex", "a".repeat(16)), report("openai-codex", "b".repeat(16), { accountLabel: "hj*", accountAlias: "Lab" })]);
  assert.deepEqual(diffLoginAccounts(before, added, "openai-codex"), { added: [{ provider: "openai-codex", accountKey: "b".repeat(16), name: "Lab" }], sameAccount: false });
  assert.deepEqual(diffLoginAccounts(before, before, "openai-codex"), { added: [], sameAccount: true });
  // A provider without usage reports cannot tell either way.
  assert.deepEqual(diffLoginAccounts(before, before, "deepseek"), { added: [], sameAccount: false });
});
