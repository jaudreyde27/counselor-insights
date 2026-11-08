import { getCurrentCounselor } from "@/lib/auth";
import { isSameSiteRequest, removeStudentWithRecordings } from "@/lib/remove-student";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/students/{id}: deletes the student, all their sessions, transcripts and analyses, and their
 * recordings. Only the signed-in counselor who owns the student can do it. (A plain request instead of a form
 * action: the form version did nothing on the deployed site, 2026-11-07.)
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameSiteRequest(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const counselor = await getCurrentCounselor();
  if (!counselor) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!UUID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const deleted = await removeStudentWithRecordings(counselor.id, id);
  return deleted ? Response.json({ ok: true }) : Response.json({ error: "Not found" }, { status: 404 });
}
