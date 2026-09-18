import { readPetAsset } from "@/lib/pet-store";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  if (!/^(codex|imported)-[a-f0-9]{32}$/.test(key)) return new Response(null, { status: 404 });
  try {
    const asset = await readPetAsset(key);
    if (!asset) return new Response(null, { status: 404 });
    const headers = { "Content-Type": asset.type, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=60", ETag: `"${asset.digest}"` };
    if (request.headers.get("if-none-match") === headers.ETag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(asset.bytes), { headers });
  } catch { return new Response(null, { status: 404 }); }
}
