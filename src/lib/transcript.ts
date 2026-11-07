import type { Speaker } from "./analysis/types";

export interface ParsedUtterance {
  speaker: Speaker;
  text: string;
}

export type ParseResult =
  | { ok: true; utterances: ParsedUtterance[] }
  | { ok: false; error: string };

const LINE = /^\s*(counselor|student)\s*:\s*(.*)$/i;

/**
 * Parses a pasted transcript. Each line starts with "Counselor:" or "Student:"
 * (any capitalization). A non-empty line with no label is treated as more of
 * the previous speaker's turn. Blank lines are ignored. No timestamps.
 */
export function parsePastedTranscript(raw: string): ParseResult {
  const utterances: ParsedUtterance[] = [];
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const match = LINE.exec(line);
    if (match) {
      const text = match[2].trim();
      if (!text) continue; // a label with nothing after it
      utterances.push({ speaker: match[1].toLowerCase() as Speaker, text });
    } else if (utterances.length === 0) {
      return {
        ok: false,
        error: `Line ${i + 1} must start with "Counselor:" or "Student:".`,
      };
    } else {
      utterances[utterances.length - 1].text += " " + line.trim();
    }
  }

  if (utterances.length === 0) {
    return { ok: false, error: 'No lines found. Start each line with "Counselor:" or "Student:".' };
  }
  if (!utterances.some((u) => u.speaker === "student")) {
    return { ok: false, error: 'No "Student:" lines found, so there is nothing to analyze.' };
  }
  return { ok: true, utterances };
}

/** Largest transcript file accepted (characters). Real sessions are a small fraction of this. */
export const MAX_TRANSCRIPT_CHARS = 200_000;

/**
 * Reads an uploaded transcript file. Two formats:
 * - plain text (.txt): each line starts with "Counselor:" or "Student:"
 * - JSON (.json): an array of { "speaker": "counselor" | "student", "text": "..." }
 */
export function parseTranscriptFile(fileName: string, content: string): ParseResult {
  if (content.length > MAX_TRANSCRIPT_CHARS) return { ok: false, error: "That transcript file is too large." };
  const text = content.replace(/^﻿/, ""); // a byte-order mark some editors add

  const looksJson = /\.json$/i.test(fileName) || text.trimStart().startsWith("[");
  if (!looksJson) return parsePastedTranscript(text);

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "That JSON file could not be read." };
  }
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: false, error: "The JSON file must be a list of lines, each with a speaker and text." };
  }
  const utterances: ParsedUtterance[] = [];
  for (const item of data) {
    const speaker = (item as { speaker?: unknown })?.speaker;
    const line = (item as { text?: unknown })?.text;
    if ((speaker !== "counselor" && speaker !== "student") || typeof line !== "string" || !line.trim()) {
      return { ok: false, error: 'Each JSON line needs "speaker" ("counselor" or "student") and non-empty "text".' };
    }
    utterances.push({ speaker, text: line.trim() });
  }
  if (!utterances.some((u) => u.speaker === "student")) {
    return { ok: false, error: 'No "student" lines found, so there is nothing to analyze.' };
  }
  return { ok: true, utterances };
}
