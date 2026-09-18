import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { addWallpaperRoot, deleteWallpaper, listWallpapers } from "@/lib/wallpaper-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return Response.json(await listWallpapers(new URL(request.url).searchParams.has("refresh"))); }
  catch { return Response.json({ error: "Unable to read wallpaper library" }, { status: 500 }); }
}
export async function POST(request: Request) {
  try {
    const data = await parseJsonWithinLimit<{ folder?: unknown }>(request, 4096);
    if (typeof data.folder !== "string") throw new Error("Folder is required");
    await addWallpaperRoot(data.folder);
    return Response.json(await listWallpapers());
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
export async function DELETE(request: Request) {
  try {
    const data = await parseJsonWithinLimit<{ id: string }>(request, 1024);
    await deleteWallpaper(data.id);
    return Response.json({ ok: true });
  } catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
}
