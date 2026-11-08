import { withCounselor } from "@/lib/db";
import { audioKeysForStudent } from "@/lib/data/sessions";
import { deleteStudent } from "@/lib/data/students";
import { logEvent } from "@/lib/log";
import { getAudioStorage } from "@/lib/storage";

/**
 * Deletes a student and everything under them, then their recordings (best effort: a leftover file is logged,
 * never shown). Returns false if the student is not this counselor's. Shared by the delete button's API route.
 */
export async function removeStudentWithRecordings(counselorId: string, studentId: string): Promise<boolean> {
  const keys = await withCounselor(counselorId, (client) => audioKeysForStudent(client, studentId));
  const deleted = await withCounselor(counselorId, (client) => deleteStudent(client, counselorId, studentId));
  if (deleted) {
    const storage = getAudioStorage();
    await Promise.all(keys.map((k) => storage.remove(k).catch(() => logEvent("audio_delete_failed"))));
  }
  return Boolean(deleted);
}

/** Buttons call these routes with fetch from our own pages. Refuse requests that come from another site. */
export function isSameSiteRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}
