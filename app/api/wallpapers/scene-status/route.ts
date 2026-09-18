export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return Response.json({ available: true, backend: "browser-webgl", streaming: false }); }
