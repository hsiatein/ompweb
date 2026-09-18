import { NextResponse } from "next/server";
import { importPet, listPets, parsePetUpload, removePet } from "@/lib/pet-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return NextResponse.json(await listPets()); }
  catch { return NextResponse.json({ error: "Unable to read pet library" }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const upload = await parsePetUpload(request);
    return NextResponse.json({ pet: await importPet(upload.manifest, upload.bytes) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid pet upload";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const key = new URL(request.url).searchParams.get("key") || "";
  if (!/^imported-[a-f0-9]{32}$/.test(key)) return NextResponse.json({ error: "Only imported pets can be deleted" }, { status: 403 });
  try {
    const removed = await removePet(key);
    return NextResponse.json({ removed }, { status: removed ? 200 : 404 });
  } catch { return NextResponse.json({ error: "Unable to delete pet" }, { status: 400 }); }
}
