import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const load = () => jiti.import("./text-links.ts");
const values = (links) => links.map((link) => `${link.kind}:${link.value}`);

test("finds URLs and paths in Chinese and English prose, without trailing punctuation", async () => {
  const { findTextLinks } = await load();
  const text = "打开 http://192.0.2.10:30177，或访问https://example.com/a_(b)). 文件在 ~/.local/share/ompweb/bin/omp。改了 components/MarkdownCode.tsx:12 和 /tmp/omp-exp-cwd/t.csv.";
  assert.deepEqual(values(findTextLinks(text)), [
    "url:http://192.0.2.10:30177",
    "url:https://example.com/a_(b)",
    "path:~/.local/share/ompweb/bin/omp",
    "path:components/MarkdownCode.tsx:12",
    "path:/tmp/omp-exp-cwd/t.csv",
  ]);
});

test("keeps commands, fractions, routes, domains and slash words as text", async () => {
  const { findTextLinks } = await load();
  const text = "发 /reset 或 /compact，1/2 的 and/or TCP/IP 用 GET /api/sessions/x，看 example.com/index.html，日期 2026/11/13，abc/def 无扩展名";
  assert.deepEqual(findTextLinks(text), []);
});

test("never links a fragment of a longer token", async () => {
  const { findTextLinks } = await load();
  assert.deepEqual(values(findTextLinks("see https://a.io/x/y.ts and foo_bar/baz.ts")), ["url:https://a.io/x/y.ts", "path:foo_bar/baz.ts"]);
  assert.deepEqual(values(findTextLinks("C:\\Users\\me\\a.txt ./run.sh ../up/x")), ["path:C:\\Users\\me\\a.txt", "path:./run.sh", "path:../up/x"]);
});

test("whole inline-code spans: paths and URLs including non-ASCII names, not commands", async () => {
  const { matchWholeTextLink } = await load();
  assert.deepEqual(matchWholeTextLink("~/projects/绘图"), { value: "~/projects/绘图", kind: "path" });
  assert.deepEqual(matchWholeTextLink("lib/text-links.ts"), { value: "lib/text-links.ts", kind: "path" });
  assert.deepEqual(matchWholeTextLink("http://127.0.0.1:30178/"), { value: "http://127.0.0.1:30178/", kind: "url" });
  for (const text of ["/compact", "providers: []", "npm run dev", "/api/home", "a/b", "train", "https: x"]) {
    assert.equal(matchWholeTextLink(text), null, text);
  }
});

test("home expansion waits for the home directory", async () => {
  const { expandHomePath } = await load();
  assert.equal(expandHomePath("~/qq-chat", "/home/me"), "/home/me/qq-chat");
  assert.equal(expandHomePath("~/qq-chat", null), null);
  assert.equal(expandHomePath("/tmp/x", null), "/tmp/x");
});
