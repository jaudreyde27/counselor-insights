import { getCurrentCounselor } from "@/lib/auth";
import { withCounselor } from "@/lib/db";
import { audit } from "@/lib/data/audit";
import { defaultAudioDeps, startTranscription } from "@/lib/transcription/process";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/sessions/{id}/upload-complete. The browser calls this after its PUT to storage. The
 * server checks the file is really there (HeadObject on S3), sets the session to `uploaded`, and
 * starts the transcription. If the file is missing, the session is marked failed.
 * Only the signed-in counselor who owns the session can call it.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const counselor = await getCurrentCounselor();
  if (!counselor) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!UUID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });

  const owns = await withCounselor(counselor.id, async (c) => {
    const r = await c.query<{ student_id: string; source: string }>("SELECT student_id, source FROM sessions WHERE id = $1", [id]);
    if (r.rowCount === 0 || r.rows[0].source !== "audio") return false;
    await audit(c, counselor.id, "audio_uploaded", { studentId: r.rows[0].student_id, sessionId: id });
    return true;
  });
  if (!owns) return Response.json({ error: "Not found" }, { status: 404 });

  // With the local mock the transcriber's own timer calls the webhook; with AssemblyAI the webhook comes from them.
  const outcome = await startTranscription(counselor.id, id, defaultAudioDeps());
  return Response.json({ status: outcome });
}
