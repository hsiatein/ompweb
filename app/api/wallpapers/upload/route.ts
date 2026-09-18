import { importWallpaper } from "@/lib/wallpaper-store";
import type { NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-request-guard";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const denied = guardApiRequest(request);
  if (denied) return denied;
  try {
    return Response.json(await importWallpaper(request, new URL(request.url).searchParams.get("name") || ""));
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
