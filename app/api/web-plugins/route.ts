import { NextResponse } from "next/server";
import { listWebPlugins, restartWebPlugin, setWebPluginEnabled, WebPluginError, webPluginsRoot } from "@/lib/web-plugins";

export const dynamic = "force-dynamic";

// GET  /api/web-plugins → { root, plugins }
// POST /api/web-plugins { id, enabled } | { id, action: "restart" }
export async function GET() {
  return NextResponse.json({ root: webPluginsRoot(), plugins: listWebPlugins() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  const input = body as { id?: unknown; enabled?: unknown; action?: unknown } | null;
  if (!input || typeof input.id !== "string" || (typeof input.enabled !== "boolean" && input.action !== "restart")) {
    return NextResponse.json({ error: "Provide id and boolean enabled, or action \"restart\"", code: "invalid_request" }, { status: 400 });
  }
  try {
    if (input.action === "restart") await restartWebPlugin(input.id);
    else await setWebPluginEnabled(input.id, input.enabled as boolean);
  } catch (error) {
    const status = error instanceof WebPluginError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
  return NextResponse.json({ root: webPluginsRoot(), plugins: listWebPlugins() });
}
