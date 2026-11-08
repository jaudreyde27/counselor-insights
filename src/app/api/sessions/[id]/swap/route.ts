import { getCurrentCounselor } from "@/lib/auth";
import { withCounselor } from "@/lib/db";
import { swapSpeakers } from "@/lib/data/sessions";
import { isSameSiteRequest } from "@/lib/remove-student";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/sessions/{id}/swap: swaps who is the counselor and who is the student on every line. Owner only. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameSiteRequest(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const counselor = await getCurrentCounselor();
  if (!counselor) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!UUID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const swapped = await withCounselor(counselor.id, (client) => swapSpeakers(client, counselor.id, id));
  return swapped ? Response.json({ ok: true }) : Response.json({ error: "Not found" }, { status: 404 });
}
