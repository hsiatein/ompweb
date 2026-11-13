import { getWebModels } from "@/lib/web-models";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getWebModels());
}
