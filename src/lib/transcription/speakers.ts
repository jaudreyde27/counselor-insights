import type { Speaker } from "../analysis/types";
import type { RawUtterance } from "./types";

export interface MappedUtterance {
  speaker: Speaker;
  raw_speaker_label: string;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

/**
 * Speaker mapping (SPEC.md step 3): the first speaker is labeled "counselor" and the other
 * "student". Wrong labels are a known risk (accented English, overlapping speech); the session
 * page's "Swap speakers" button is the fix. `studentLabel` is the transcription service's own
 * label for the student (for example "B"), kept so a swap stays consistent.
 * With only one speaker detected, every line is treated as the student's.
 */
export function mapSpeakers(raw: RawUtterance[]): { utterances: MappedUtterance[]; studentLabel: string | null } {
  const lines = raw.filter((u) => u.text.trim());
  if (lines.length === 0) return { utterances: [], studentLabel: null };

  const labels = [...new Set(lines.map((u) => u.speaker))];
  const counselorLabel = labels.length > 1 ? labels[0] : null;
  const studentLabel = labels.length > 1 ? labels[1] : labels[0];

  return {
    studentLabel,
    utterances: lines.map((u) => ({
      speaker: u.speaker === counselorLabel ? "counselor" : "student",
      raw_speaker_label: u.speaker,
      start_ms: u.start_ms ?? null,
      end_ms: u.end_ms ?? null,
      text: u.text.trim(),
    })),
  };
}
