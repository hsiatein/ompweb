import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveWebProject, safeWallpaperFile, mediaRange } from "@/lib/wallpaper-store";
import { resourceName } from "@/lib/wallpaper-binary";
import { wallpaperFileStream } from "@/lib/wallpaper-file-stream";
import { validWebWallpaperToken, webWallpaperHeaders, webWallpaperHtml } from "@/lib/wallpaper-web";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const types: Record<string, string> = { ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".wasm": "application/wasm", ".glsl": "text/plain", ".vert": "text/plain", ".frag": "text/plain" };
type Context = { params: Promise<{ id: string; token: string; file: string[] }> };
async function serve(request: Request, context: Context) {
  const { id, token, file } = await context.params;
  if (!validWebWallpaperToken(id, token)) return new Response(null, { status: 403 });
  const url = new URL(request.url);
  const host = request.headers.get("host") || url.host;
  const origin = new URL(`${url.protocol}//${host}`).origin;
  const headers = webWallpaperHeaders(origin, id, token);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  try {
    const relative = resourceName(file.join("/"));
    let mime = types[path.extname(relative).toLowerCase()];
    if (!mime) throw new Error("Unsupported web resource");
    const project = await resolveWebProject(id);
    let safe: string;
    try { safe = await safeWallpaperFile(project.folder, relative); }
    catch (error) {
      // Old RainEffect exports refer to city.jpg after renaming it city.png.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || relative !== "img/city.jpg" || !String(project.metadata.description || "").includes("github.com/codrops/RainEffect")) throw error;
      safe = await safeWallpaperFile(project.folder, "img/city.png"); mime = "image/png";
    }
    const stat = await fs.stat(safe);
    if (stat.size > 512 * 1024 * 1024) throw new Error("Web resource too large");
    headers.set("Content-Type", mime);
    if (mime === "text/html") {
      if (stat.size > 2 * 1024 * 1024) throw new Error("Web entry too large");
      headers.set("Cache-Control", "no-store");
      const html = webWallpaperHtml(await fs.readFile(safe, "utf8"), project.metadata);
      return new Response(request.method === "HEAD" ? null : html, { headers });
    }
    const range = mediaRange(request.headers.get("range"), stat.size);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Length", String(range ? range.end - range.start + 1 : stat.size));
    if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    return new Response(wallpaperFileStream(await fs.open(safe, "r"), range?.start ?? 0, range?.end ?? stat.size - 1), { status: range ? 206 : 200, headers });
  } catch { return new Response(null, { status: 404, headers }); }
}
export const GET = serve;
export const HEAD = serve;
export const OPTIONS = serve;
