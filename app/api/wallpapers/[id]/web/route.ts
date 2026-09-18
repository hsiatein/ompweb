import { guardApiRequest } from "@/lib/api-request-guard";
import { webWallpaperManifest } from "@/lib/wallpaper-web";
import type { NextRequest } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = guardApiRequest(request); if (denied) return denied;
  try { return Response.json(await webWallpaperManifest((await context.params).id), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) { return Response.json({ error: (e as Error).message }, { status: 422 }); }
}
