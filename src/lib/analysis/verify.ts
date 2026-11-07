import type { Evidence, Utterance } from "./types";

/**
 * Lowercases and reduces text to words separated by single spaces, so that
 * differences in case, spacing and punctuation (including curly vs straight
 * quotes) do not matter when comparing a quote to an utterance.
 */
export function normalizeForQuote(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['‘’ʼ`´]/g, "") // it's / it’s / its all compare equal
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type DropReason = "empty_quote" | "unknown_utterance" | "wrong_speaker" | "quote_not_found";

export interface EvidenceCheck {
  kept: Evidence[];
  dropped: Array<{ evidence: Evidence; reason: DropReason }>;
}

/**
 * Verifies evidence items against the stored utterances (SPEC.md 6.3):
 * 1. the utterance id must exist in this session,
 * 2. the quote must appear as a contiguous run of whole words in that utterance
 *    (after normalizing case, whitespace and punctuation on both sides),
 * 3. the utterance must be the student's (themes are about the student).
 * Anything that fails is dropped. This is code, never the model.
 */
export function verifyEvidence(items: Evidence[], utterances: Utterance[]): EvidenceCheck {
  const byId = new Map(utterances.map((u) => [u.id, u]));
  const kept: Evidence[] = [];
  const dropped: EvidenceCheck["dropped"] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const quote = normalizeForQuote(item.quote);
    const utterance = byId.get(item.utterance_id);
    let reason: DropReason | null = null;

    if (!quote) reason = "empty_quote";
    else if (!utterance) reason = "unknown_utterance";
    else if (utterance.speaker !== "student") reason = "wrong_speaker";
    else if (!` ${normalizeForQuote(utterance.text)} `.includes(` ${quote} `)) reason = "quote_not_found";

    if (reason) {
      dropped.push({ evidence: item, reason });
      continue;
    }
    const key = `${item.utterance_id}|${quote}`;
    if (seen.has(key)) continue; // exact repeat: keep one, not counted as a failure
    seen.add(key);
    kept.push(item);
  }
  return { kept, dropped };
}
