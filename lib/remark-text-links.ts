import type { Link, Parent, PhrasingContent, Root, Text } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";
import { classifyTextLink, findTextLinks, TEXT_LINK_RE } from "./text-links";

/**
 * GFM's literal autolinks run to the next whitespace, so a URL followed by
 * Chinese text swallows it (`https://a.com/x。然后`). Cut such a link where
 * lib/text-links.ts ends the URL and give the rest back as text.
 */
function trimLiteralAutolinks(parent: Parent): void {
  for (let index = 0; index < parent.children.length; index++) {
    const node = parent.children[index];
    if (node.type !== "link") {
      if ("children" in node) trimLiteralAutolinks(node as Parent);
      continue;
    }
    if (node.children.length !== 1 || node.children[0].type !== "text") continue;
    const text = (node.children[0] as Text).value;
    if (node.url !== text && node.url !== `http://${text}`) continue;
    const first = findTextLinks(text)[0];
    if (!first || first.start !== 0 || first.kind !== "url" || first.end >= text.length) continue;
    const head: Link = { ...node, url: first.value, children: [{ type: "text", value: first.value }] };
    parent.children.splice(index, 1, head, { type: "text", value: text.slice(first.end) } as PhrasingContent);
    index++;
  }
}

/**
 * Links bare URLs and local paths in Markdown prose (lib/text-links.ts rules).
 * Runs after remark-gfm, so URLs GFM already linked are left alone (apart
 * from the trimming above); it also catches URLs GFM misses. Existing links
 * and code are untouched. Links carry `data-text-link="url|path"` so the
 * renderer can drop a path it cannot open instead of sending it to the browser.
 */
export function remarkTextLinks() {
  return (tree: Root) => {
    trimLiteralAutolinks(tree);
    findAndReplace(
      tree,
      [
        new RegExp(TEXT_LINK_RE.source, "g"),
        (match: string): PhrasingContent[] | false => {
          const link = classifyTextLink(match);
          if (!link) return false;
          const node: Link = {
            type: "link",
            url: link.value,
            children: [{ type: "text", value: link.value }],
            data: { hProperties: { "data-text-link": link.kind } },
          };
          const rest = match.slice(link.value.length);
          return rest ? [node, { type: "text", value: rest }] : [node];
        },
      ],
      { ignore: ["link", "linkReference"] },
    );
  };
}
