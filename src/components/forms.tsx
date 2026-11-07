"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, startTransition, type FormEvent } from "react";
import { addSessionAction, createStudentAction, prepareAudioUploadAction } from "@/app/actions";
import type { FormState } from "@/lib/form-state";
import { audioTypeFor, extensionOf } from "@/lib/storage/audio-types";
import { DEGREE_TYPES, SCHOOLS } from "@/lib/student-options";
import { Field, inputClass, primaryButton, SmallCaps } from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

type Mode = "audio" | "transcript";

const AUDIO_ACCEPT = "audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,.mp3,.m4a,.wav";
const TRANSCRIPT_ACCEPT = ".txt,.json,text/plain,application/json";

const fileClass =
  "block w-full text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-accent-dark";
const smallFileClass =
  "block w-full text-xs text-muted file:mr-2 file:cursor-pointer file:rounded-md file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-accent-dark";

/** Audio / Transcript switch. Audio is first, and the default. */
function ModeTabs({ mode, setMode, small = false }: { mode: Mode; setMode: (m: Mode) => void; small?: boolean }) {
  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={`rounded-md font-medium ${small ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"} ${
        mode === m ? "bg-accent text-white" : "text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="tablist" className="inline-flex gap-1 rounded-lg border border-line bg-canvas p-0.5">
      {tab("audio", small ? "Audio" : "Audio recording")}
      {tab("transcript", small ? "Transcript" : "Transcript file")}
    </div>
  );
}

/**
 * Full-size upload area for the New Student form: a recording (the main way) or a
 * transcript file. Both inputs stay mounted so a chosen file survives switching tabs.
 */
function UploadSection({ mode, setMode, optional = false }: { mode: Mode; setMode: (m: Mode) => void; optional?: boolean }) {
  return (
    <div>
      <input type="hidden" name="source" value={mode} />
      <ModeTabs mode={mode} setMode={setMode} />
      <div className="mt-3 rounded-lg border border-dashed border-line bg-canvas p-4">
        <div className={mode === "audio" ? "space-y-3" : "hidden"}>
          <Field label="Session recording" required={!optional} help="MP3, M4A or WAV. Recordings are about 10 to 15 minutes.">
            <input type="file" name="audio_file" accept={AUDIO_ACCEPT} required={!optional && mode === "audio"} className={fileClass} />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" required={!optional && mode === "audio"} className="mt-0.5 h-4 w-4 accent-accent" />
            <span>
              The student has consented to this recording{!optional && <span className="ml-0.5 text-red-600">*</span>}
            </span>
          </label>
        </div>
        <div className={mode === "transcript" ? "block" : "hidden"}>
          <Field
            label="Transcript file"
            required={!optional}
            help='A text file (.txt) where each line starts with "Counselor:" or "Student:". A .json list of lines also works.'
          >
            <input
              type="file"
              name="transcript_file"
              accept={TRANSCRIPT_ACCEPT}
              required={!optional && mode === "transcript"}
              className={fileClass}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

/**
 * The browser's half of an audio upload (SPEC.md step 1): ask the server for a 15-minute link, send
 * the file straight to storage with one PUT (with progress), then tell the server it is done so it
 * can check the file and start transcribing. Only the file's extension and type go to the server,
 * never its name. If the PUT fails, the server is still told, so it can mark the session failed.
 */
async function uploadRecording(
  data: FormData,
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ ok: true; studentId: string } | { ok: false; error: string }> {
  const type = audioTypeFor(extensionOf(file.name), file.type);
  if (!type) return { ok: false, error: "Choose an MP3, M4A or WAV recording." };
  if (data.get("consent") !== "on") return { ok: false, error: "Please confirm the student consented to this recording." };

  const prep = new FormData();
  for (const [k, v] of data.entries()) if (typeof v === "string") prep.set(k, v); // text fields only, never files
  prep.set("file_ext", type.ext);
  prep.set("file_type", file.type);
  const made = await prepareAudioUploadAction(prep);
  if (!made.ok) return made;

  const putOk = await new Promise<boolean>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", made.uploadUrl);
    xhr.setRequestHeader("Content-Type", made.contentType); // must match what the link was made for
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(file);
  });

  const done = await fetch(`/api/sessions/${made.sessionId}/upload-complete`, { method: "POST" }).catch(() => null);
  const body = done && done.ok ? ((await done.json().catch(() => null)) as { status?: string } | null) : null;
  if (!putOk || !body || body.status === "failed") {
    return { ok: false, error: "The upload did not finish. Please try again." };
  }
  return { ok: true, studentId: made.studentId };
}

/** Shared submit logic for both forms. Never lets React reset the form, so typed text is kept. */
function useSessionSubmit(action: (fd: FormData) => void, mode: Mode, optional: boolean) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const audio = data.get("audio_file");
    const hasAudio = audio instanceof File && audio.size > 0;
    setError(null);

    if (mode === "audio" && hasAudio) {
      setBusy(true);
      setProgress(0);
      uploadRecording(data, audio, setProgress)
        .then((res) => {
          if (res.ok) {
            // Success can leave us on the same page (adding a session), so clear the form and the bar.
            form.reset();
            setBusy(false);
            setProgress(null);
            router.push(`/students/${res.studentId}`);
            router.refresh();
          } else {
            setError(res.error);
            setBusy(false);
            setProgress(null);
          }
        })
        .catch(() => {
          setError("Something went wrong with the upload. Please try again.");
          setBusy(false);
          setProgress(null);
        });
      return;
    }
    if (mode === "audio" && !optional) {
      setError("Choose a recording to upload.");
      return;
    }
    data.delete("audio_file"); // never send a recording through a form action
    startTransition(() => action(data));
  };
  return { onSubmit, error, progress, busy };
}

function ErrorNote({ message, small = false }: { message?: string | null; small?: boolean }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className={`rounded-lg border border-red-200 bg-red-50 text-red-800 ${small ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm"}`}
    >
      {message}
    </p>
  );
}

/** Upload progress. At 100% the file is in storage and the server is starting the transcription. */
function UploadProgress({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  return (
    <div role="status" aria-live="polite" className="w-full">
      <div className="mb-1 text-xs text-muted">
        {percent < 100 ? `Uploading the recording… ${percent}%` : "Upload complete. Starting the transcription…"}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function SchoolSelect({ defaultValue }: { defaultValue?: string }) {
  return (
    <Field label="School" required>
      <select name="school" required defaultValue={defaultValue ?? ""} className={inputClass}>
        <option value="" disabled>
          Choose a school…
        </option>
        {SCHOOLS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * Page 3: creates the student, and optionally uploads their first session.
 * Columns follow the width of the space the form is in (a container query), so the
 * fields run left to right even in a narrow window, and stack only on a phone.
 */
export function NewStudentForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createStudentAction, undefined);
  const [mode, setMode] = useState<Mode>("audio");
  const { onSubmit, error, progress, busy } = useSessionSubmit(action, mode, true);
  const v = state?.values ?? {};
  return (
    <div className="@container">
      <form
        onSubmit={onSubmit}
        // If the form is submitted before the page's JavaScript has loaded, the browser must never put
        // the fields in the web address (the default for forms is GET). POST keeps them in the body.
        method="post"
        encType="multipart/form-data"
        className="space-y-6 rounded-xl border border-line bg-surface p-6"
      >
        <div className="space-y-4">
          <SmallCaps>Student</SmallCaps>
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-3">
            <Field label="Full name" required>
              <input name="full_name" required maxLength={200} defaultValue={v.full_name} className={inputClass} />
            </Field>
            <Field label="Country of origin" required>
              <input name="country_of_origin" required maxLength={200} defaultValue={v.country_of_origin} className={inputClass} />
            </Field>
            <SchoolSelect defaultValue={v.school} />
            <Field label="Degree" required>
              <select name="degree_type" required defaultValue={v.degree_type ?? ""} className={inputClass}>
                <option value="" disabled>
                  Bachelors or Masters…
                </option>
                {DEGREE_TYPES.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="@xl:col-span-2">
              <Field label="Program of study" required>
                <input name="program_of_study" required maxLength={200} defaultValue={v.program_of_study} className={inputClass} />
              </Field>
            </div>
            <div className="@xl:col-span-3">
              <Field label="Key notes" help="A few notes for you about the student. Never sent to the analysis.">
                <input
                  name="notes"
                  maxLength={5000}
                  defaultValue={v.notes}
                  placeholder="e.g. wants to become an engineer after graduating"
                  className={inputClass}
                />
              </Field>
            </div>
          </div>
        </div>

        <div className="space-y-4 border-t border-line pt-5">
          <SmallCaps>First session (optional)</SmallCaps>
          <p className="-mt-2 text-sm text-muted">
            You can upload the first session now, or create the student first and add sessions later from their page.
          </p>
          <div className="grid grid-cols-1 gap-4 @xl:grid-cols-[2fr_1fr]">
            <UploadSection mode={mode} setMode={setMode} optional />
            <Field label="Session date" help="Used if you upload a session.">
              <input name="session_date" type="date" defaultValue={v.session_date || today()} className={inputClass} />
            </Field>
          </div>
        </div>

        <UploadProgress percent={progress} />
        <ErrorNote message={error ?? state?.error} />
        <div className="flex justify-end">
          <button className={primaryButton} disabled={pending || busy}>
            {pending || busy ? "Creating…" : "Create student"}
          </button>
        </div>
      </form>
    </div>
  );
}

const smallInput =
  "rounded-lg border border-line bg-surface px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40";

/**
 * The "Add a session" call to action at the very top of a student's page: one slim row
 * (title, Audio/Transcript switch, file, date, button) that wraps on narrow screens.
 */
export function AddSessionForm({ studentId }: { studentId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(addSessionAction, undefined);
  const [mode, setMode] = useState<Mode>("audio");
  const { onSubmit, error, progress, busy } = useSessionSubmit(action, mode, false);
  const v = state?.values ?? {};
  const shownError = error ?? state?.error;
  return (
    <form
      onSubmit={onSubmit}
      method="post"
      encType="multipart/form-data"
      className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-3"
    >
      <input type="hidden" name="student_id" value={studentId} />
      <input type="hidden" name="source" value={mode} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-base font-semibold">Add a session</h2>
        <ModeTabs mode={mode} setMode={setMode} small />
        <div className="min-w-[11rem] flex-1">
          <input
            type="file"
            name="audio_file"
            aria-label="Session recording (MP3, M4A or WAV)"
            title="MP3, M4A or WAV"
            accept={AUDIO_ACCEPT}
            required={mode === "audio"}
            className={mode === "audio" ? smallFileClass : "hidden"}
          />
          <input
            type="file"
            name="transcript_file"
            aria-label="Transcript file (.txt or .json)"
            title='A text file where each line starts with "Counselor:" or "Student:"'
            accept={TRANSCRIPT_ACCEPT}
            required={mode === "transcript"}
            className={mode === "transcript" ? smallFileClass : "hidden"}
          />
        </div>
        <label className="flex items-center gap-2 text-xs font-medium">
          Date
          <input name="session_date" type="date" required defaultValue={v.session_date || today()} className={smallInput} />
        </label>
        {mode === "audio" && (
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" name="consent" required className="h-3.5 w-3.5 accent-accent" />
            Student consented to this recording
          </label>
        )}
        <button className={`${primaryButton} px-3 py-1.5`} disabled={pending || busy}>
          {pending || busy ? "Adding…" : "Add session"}
        </button>
      </div>
      {progress !== null && (
        <div className="mt-2">
          <UploadProgress percent={progress} />
        </div>
      )}
      {shownError && (
        <div className="mt-2">
          <ErrorNote message={shownError} small />
        </div>
      )}
    </form>
  );
}
