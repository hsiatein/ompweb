import { mediaRange, resolveWallpaperMedia } from "@/lib/wallpaper-store";
import { wallpaperFileStream } from "@/lib/wallpaper-file-stream";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function serve(request: Request, context: { params: Promise<{ id: string }> }, head: boolean) {
  let media;
  try { media = await resolveWallpaperMedia((await context.params).id, new URL(request.url).searchParams.get("preview") === "1"); }
  catch { return new Response(null, { status: 404 }); }
  const { handle, mime, stat } = media;
  let range;
  try { range = mediaRange(request.headers.get("range"), stat.size); }
  catch { await handle.close(); return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } }); }
  const headers = new Headers({ "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff", "Content-Length": String(range ? range.end - range.start + 1 : stat.size) });
  if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
  if (head) { await handle.close(); return new Response(null, { status: range ? 206 : 200, headers }); }
  return new Response(wallpaperFileStream(handle, range?.start ?? 0, range?.end ?? stat.size - 1), { status: range ? 206 : 200, headers });
}
export const GET = (r: Request, c: { params: Promise<{ id: string }> }) => serve(r, c, false);
export const HEAD = (r: Request, c: { params: Promise<{ id: string }> }) => serve(r, c, true);
