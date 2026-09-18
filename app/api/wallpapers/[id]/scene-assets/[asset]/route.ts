import { NextRequest } from "next/server";
import { guardApiRequest } from "@/lib/api-request-guard";
import { browserScene } from "@/lib/wallpaper-browser-scene";
import { mediaRange } from "@/lib/wallpaper-store";
import type { SceneFont, SceneTexture, SceneSound } from "@/lib/wallpaper-scene-types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; asset: string }> }) {
  const denied = guardApiRequest(request);
  if (denied) return denied;
  try {
    const { id, asset } = await context.params;
    if (!/^[a-f0-9]{64}$/.test(asset)) return new Response(null, { status: 404 });
    const scene = await browserScene(id), data = scene.assets.get(asset);
    if (!data) return new Response(null, { status: 404 });
    let range;
    try { range = mediaRange(request.headers.get("range"), data.length); }
    catch { return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${data.length}` } }); }
    const audioType = scene.manifest.sounds?.flatMap((sound: SceneSound) => sound.files).find((file: SceneSound["files"][number]) => file.key === asset)?.mimeType;
    const headers = new Headers({ "Content-Type": audioType || scene.manifest.fonts?.find((f: SceneFont) => f.key === asset)?.mimeType || scene.manifest.textures.find((t: SceneTexture) => t.key === asset)?.mimeType || "image/png", "Accept-Ranges": "bytes", "Content-Length": String(range ? range.end - range.start + 1 : data.length), "Cache-Control": "private, max-age=86400, immutable", "X-Content-Type-Options": "nosniff" });
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${data.length}`);
    return new Response(new Uint8Array(range ? data.subarray(range.start, range.end + 1) : data), { status: range ? 206 : 200, headers });
  } catch { return new Response(null, { status: 404 }); }
}
