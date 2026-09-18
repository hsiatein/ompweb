import { NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-request-guard";
import { browserScene } from "@/lib/wallpaper-browser-scene";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardApiRequest(request);
  if (denied) return denied;
  try {
    const { id } = await context.params;
    return Response.json((await browserScene(id)).manifest, { headers: { "Cache-Control": "private, no-cache" } });
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 422 }); }
}
export async function POST() { return Response.json({ error: "Scene streaming was removed. Refresh the page to use browser rendering." }, { status: 410 }); }
