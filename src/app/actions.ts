"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { startAnalysis } from "@/lib/analysis/start";
import { authMode, requireCounselor, signInDev, signOut } from "@/lib/auth";
import { cognitoConfig, logoutUrl } from "@/lib/auth/cognito";
import { withCounselor } from "@/lib/db";
import { audit } from "@/lib/data/audit";
import { createAudioSession, createPastedSession } from "@/lib/data/sessions";
import { createStudent, type StudentInput } from "@/lib/data/students";
import type { FormState } from "@/lib/form-state";
import { getAudioStorage } from "@/lib/storage";
import { audioTypeFor, UPLOAD_URL_SECONDS } from "@/lib/storage/audio-types";
import { isDegreeType, isSchool } from "@/lib/student-options";
import { defaultAudioDeps, finishTranscription, startTranscription } from "@/lib/transcription/process";
import { parseTranscriptFile } from "@/lib/transcript";

// Server actions can be called directly over the network, so every one of them
// checks who is signed in and only touches that counselor's rows (row-level security).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const idOf = (f: FormData, k: string) => {
  const v = text(f, k);
  return UUID.test(v) ? v : null;
};

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Reads a transcript-file session from a form. Returns an error message or the parsed values. */
async function readSession(f: FormData) {
  const date = text(f, "session_date");
  if (!validDate(date)) return { error: "Enter a valid session date." } as const;

  const file = f.get("transcript_file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a transcript file to upload." } as const;
  if (file.size > 1_000_000) return { error: "That transcript file is too large." } as const;
  const parsed = parseTranscriptFile(file.name, await file.text());
  if (!parsed.ok) return { error: parsed.error } as const;

  return { date, utterances: parsed.utterances } as const;
}

/** Reads and checks the student fields. Returns an error message or the clean values. */
function readStudentFields(f: FormData): { error: string } | { fields: StudentInput } {
  const name = text(f, "full_name");
  const school = text(f, "school");
  const degree = text(f, "degree_type");
  const program = text(f, "program_of_study");
  const country = text(f, "country_of_origin");
  const notes = text(f, "notes");
  if (!name || name.length > 200) return { error: "Enter the student's full name." };
  if (!isSchool(school)) return { error: "Choose the student's school." };
  if (!isDegreeType(degree)) return { error: "Choose Bachelors or Masters." };
  if (!program || program.length > 200) return { error: "Enter the program of study." };
  if (!country || country.length > 200) return { error: "Enter the country of origin." };
  if (notes.length > 5000) return { error: "Notes are too long." };
  return {
    fields: { full_name: name, school, degree_type: degree, program_of_study: program, country_of_origin: country, notes },
  };
}

const keep = (f: FormData, keys: string[]) => Object.fromEntries(keys.map((k) => [k, String(f.get(k) ?? "")]));
const FORM_KEYS = ["full_name", "school", "degree_type", "program_of_study", "country_of_origin", "notes", "session_date"];

// ------------------------------------------------------------------ sign-in

export async function devSignInAction(formData: FormData): Promise<void> {
  const ok = await signInDev(text(formData, "sub"));
  redirect(ok ? "/students" : "/login");
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect(authMode() === "cognito" ? logoutUrl(cognitoConfig()) : "/login");
}

// ------------------------------------------------------------------ students

export async function createStudentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const c = await requireCounselor();
  const values = keep(formData, FORM_KEYS);

  const student = readStudentFields(formData);
  if ("error" in student) return { error: student.error, values };
  // The first session is optional: a student can be created now (with their key notes) and
  // sessions added later from their page. A transcript is only read if a file was chosen.
  // (A recording goes through prepareAudioUploadAction instead.)
  const file = formData.get("transcript_file");
  const withSession = file instanceof File && file.size > 0;
  const session = withSession ? await readSession(formData) : null;
  if (session && "error" in session) return { error: session.error, values };

  const { studentId, sessionId } = await withCounselor(c.id, async (client) => {
    const studentId = await createStudent(client, c.id, student.fields);
    const sessionId = session
      ? await createPastedSession(client, {
          counselorId: c.id,
          studentId,
          sessionDate: session.date,
          utterances: session.utterances,
        })
      : null;
    return { studentId, sessionId };
  });

  if (sessionId) after(() => startAnalysis(c.id, sessionId));
  redirect(`/students/${studentId}`);
}

// ------------------------------------------------------------------ sessions

export async function addSessionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const c = await requireCounselor();
  const values = keep(formData, FORM_KEYS);
  const studentId = idOf(formData, "student_id");
  if (!studentId) return { error: "Student not found.", values };
  const session = await readSession(formData);
  if ("error" in session) return { error: session.error, values };

  const sessionId = await withCounselor(c.id, async (client) => {
    const exists = await client.query("SELECT 1 FROM students WHERE id = $1", [studentId]);
    if (exists.rowCount === 0) return null;
    return createPastedSession(client, {
      counselorId: c.id,
      studentId,
      sessionDate: session.date,
      utterances: session.utterances,
    });
  });
  if (!sessionId) return { error: "Student not found.", values };

  after(() => startAnalysis(c.id, sessionId));
  redirect(`/students/${studentId}`);
}

export type PrepareUploadResult =
  | { ok: true; studentId: string; sessionId: string; uploadUrl: string; contentType: string }
  | { ok: false; error: string };

/**
 * Step 1 of an audio upload (SPEC.md): checks the consent tick (saved with a timestamp), creates the
 * student if this is a new one, creates the session as `awaiting_upload`, and returns a link that
 * lasts 15 minutes. The browser then sends the file straight to storage with one PUT (the recording
 * never passes through this server) and calls /api/sessions/{id}/upload-complete. Only the file's
 * extension and type are sent here, never its name.
 */
export async function prepareAudioUploadAction(formData: FormData): Promise<PrepareUploadResult> {
  const c = await requireCounselor();

  const type = audioTypeFor(text(formData, "file_ext"), text(formData, "file_type"));
  if (!type) return { ok: false, error: "Choose an MP3, M4A or WAV recording." };
  if (text(formData, "consent") !== "on") return { ok: false, error: "Please confirm the student consented to this recording." };
  const date = text(formData, "session_date");
  if (!validDate(date)) return { ok: false, error: "Enter a valid session date." };

  const existingId = idOf(formData, "student_id");
  let student: ReturnType<typeof readStudentFields> | null = null;
  if (!existingId) {
    student = readStudentFields(formData);
    if ("error" in student) return { ok: false, error: student.error };
  }

  const made = await withCounselor(c.id, async (client) => {
    let studentId = existingId;
    if (studentId) {
      if ((await client.query("SELECT 1 FROM students WHERE id = $1", [studentId])).rowCount === 0) return null;
    } else if (student && "fields" in student) {
      studentId = await createStudent(client, c.id, student.fields);
    }
    if (!studentId) return null;
    const s = await createAudioSession(client, { counselorId: c.id, studentId, sessionDate: date, ext: type.ext });
    return { studentId, ...s };
  });
  if (!made) return { ok: false, error: "Student not found." };

  const uploadUrl = await getAudioStorage().createUploadUrl(made.key, type.contentType, UPLOAD_URL_SECONDS);
  return { ok: true, studentId: made.studentId, sessionId: made.sessionId, uploadUrl, contentType: type.contentType };
}

/** "Check status": fetches the transcript now, in case the webhook never arrived. */
export async function checkStatusAction(formData: FormData): Promise<void> {
  const c = await requireCounselor();
  const sessionId = idOf(formData, "session_id");
  if (!sessionId) redirect("/students");

  const studentId = await withCounselor(c.id, async (client) => {
    const r = await client.query<{ student_id: string }>("SELECT student_id FROM sessions WHERE id = $1", [sessionId]);
    if (r.rowCount === 0) return null;
    await audit(client, c.id, "check_status", { studentId: r.rows[0].student_id, sessionId });
    return r.rows[0].student_id;
  });
  if (studentId) {
    // The analysis runs after the response, like everywhere else.
    await finishTranscription(c.id, sessionId, {
      ...defaultAudioDeps(),
      analyze: async (cid, sid) => {
        after(() => startAnalysis(cid, sid));
      },
    });
  }
  redirect(`/sessions/${sessionId}`);
}

export async function rerunAnalysisAction(formData: FormData): Promise<void> {
  const c = await requireCounselor();
  const sessionId = idOf(formData, "session_id");
  if (!sessionId) redirect("/students");

  const plan = await withCounselor(c.id, async (client) => {
    const s = await client.query<{ source: string; status: string; audio_s3_key: string | null; student_id: string; utterances: number }>(
      `SELECT source, status, audio_s3_key, student_id,
              (SELECT count(*)::int FROM utterances u WHERE u.session_id = sessions.id) AS utterances
         FROM sessions WHERE id = $1`,
      [sessionId],
    );
    const row = s.rows[0];
    if (!row) return null;
    await audit(client, c.id, "rerun_analysis", { studentId: row.student_id, sessionId });

    // A recording whose transcription failed has no transcript yet: try transcribing it again.
    if (row.source === "audio" && row.audio_s3_key && row.utterances === 0 && ["failed", "uploaded"].includes(row.status)) {
      await client.query("UPDATE sessions SET status = 'uploaded', error_message = NULL WHERE id = $1", [sessionId]);
      return "transcribe" as const;
    }
    // "transcribed" = transcript is ready and analysis is queued; the page shows the processing banner.
    const r = await client.query(
      `UPDATE sessions SET status = 'transcribed', error_message = NULL
        WHERE id = $1 AND status IN ('transcribed','complete','failed') AND $2::int > 0 RETURNING id`,
      [sessionId, row.utterances],
    );
    return r.rowCount ? ("analyze" as const) : null;
  });

  if (plan === "transcribe") after(() => startTranscription(c.id, sessionId, defaultAudioDeps()).then(() => undefined));
  if (plan === "analyze") after(() => startAnalysis(c.id, sessionId));
  redirect(`/sessions/${sessionId}`);
}
