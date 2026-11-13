import { NextResponse } from "next/server";
import { readBytesWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { streamWebPlugin, webPluginRequestLimit, WebPluginError } from "@/lib/web-plugins";
import { WEB_PLUGIN_ID_RE } from "@/lib/web-plugin-types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; path: string[] }> };

// /api/web-plugins/<id>/api/<path> → the plugin server's /<path> over its unix socket.
async function forward(req: Request, { params }: Context): Promise<Response> {
  const { id, path } = await params;
  if (!WEB_PLUGIN_ID_RE.test(id)) return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
  // /__tools/* belongs to agent tool calls, never to the page.
  if (path[0] === "__tools") return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const limit = webPluginRequestLimit(id);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(await readBytesWithinLimit(req, limit));
    return await streamWebPlugin(id, {
      method: req.method,
      path: `/${path.map(encodeURIComponent).join("/")}${new URL(req.url).search}`,
      contentType: req.headers.get("content-type"),
      body,
      signal: req.signal,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: error.message }, { status: 413 });
    const status = error instanceof WebPluginError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}

export { forward as GET, forward as HEAD, forward as OPTIONS, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
