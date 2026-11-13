import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const jiti = createJiti(import.meta.url);

async function links(markdown) {
  const { remarkTextLinks } = await jiti.import("./remark-text-links.ts");
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkTextLinks);
  const tree = await processor.run(processor.parse(markdown));
  const out = [];
  const walk = (node) => {
    if (node.type === "link") out.push(`${node.url}|${node.data?.hProperties?.["data-text-link"] ?? "md"}`);
    else if (node.type === "text" && out.length && node.value.startsWith("。")) out.push(`text:${node.value}`);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}

test("prose paths become marked links; code, existing links and GFM URLs keep their own handling", async () => {
  assert.deepEqual(await links("在 ~/qq-chat/bot.py 里，见 [文档](https://a.io/d) 和 `~/x/y`，访问https://example.com/a。然后"), [
    "~/qq-chat/bot.py|path",
    "https://a.io/d|md",
    "https://example.com/a|md",
    "text:。然后",
  ]);
});
