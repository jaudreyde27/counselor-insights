import { describe, expect, it } from "vitest";
import { mentionsImmigrationStatus } from "@/lib/analysis/status-guard";
import type { Utterance } from "@/lib/analysis/types";
import { verifyEvidence } from "@/lib/analysis/verify";

const utterances: Utterance[] = [
  { id: "c1", speaker: "counselor", text: "Tell me what happened. Why do you feel alone here?" },
  { id: "s1", speaker: "student", text: "Back home I was an accountant, but it's fine." },
  { id: "s2", speaker: "student", text: "I eat dinner ALONE  in my room,\nand nobody calls." },
];

describe("quote verifier", () => {
  it("accepts an exact quote from a student utterance", () => {
    const r = verifyEvidence([{ utterance_id: "s1", quote: "Back home I was an accountant, but it's fine." }], utterances);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it("accepts a contiguous part of the utterance", () => {
    const r = verifyEvidence([{ utterance_id: "s1", quote: "I was an accountant" }], utterances);
    expect(r.kept).toHaveLength(1);
  });

  it("ignores differences in case, whitespace, punctuation and curly quotes", () => {
    const r = verifyEvidence(
      [
        { utterance_id: "s2", quote: "i eat dinner alone in my room and nobody calls" },
        { utterance_id: "s1", quote: "its fine" },
        { utterance_id: "s1", quote: "BACK HOME, I was an accountant" },
        { utterance_id: "s1", quote: "it’s   FINE" }, // same as "its fine" once normalized: kept once
      ],
      utterances,
    );
    expect(r.dropped).toEqual([]);
    expect(r.kept).toHaveLength(3);
  });

  it("fails an altered quote", () => {
    const r = verifyEvidence([{ utterance_id: "s1", quote: "Back home I was a famous accountant" }], utterances);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].reason).toBe("quote_not_found");
  });

  it("fails a quote stitched together from two places in the utterance", () => {
    const r = verifyEvidence([{ utterance_id: "s2", quote: "I eat dinner and nobody calls" }], utterances);
    expect(r.dropped[0].reason).toBe("quote_not_found");
  });

  it("fails a partial word (whole words only)", () => {
    const r = verifyEvidence([{ utterance_id: "s1", quote: "accountan" }], utterances);
    expect(r.dropped[0].reason).toBe("quote_not_found");
  });

  it("fails a quote from the wrong speaker, even though the words exist", () => {
    const r = verifyEvidence([{ utterance_id: "c1", quote: "Why do you feel alone here?" }], utterances);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].reason).toBe("wrong_speaker");
  });

  it("fails a quote attributed to the wrong utterance", () => {
    const r = verifyEvidence([{ utterance_id: "s2", quote: "Back home I was an accountant" }], utterances);
    expect(r.dropped[0].reason).toBe("quote_not_found");
  });

  it("fails an unknown utterance id and an empty quote", () => {
    const r = verifyEvidence(
      [
        { utterance_id: "nope", quote: "anything" },
        { utterance_id: "s1", quote: "  ...  " },
      ],
      utterances,
    );
    expect(r.dropped.map((d) => d.reason)).toEqual(["unknown_utterance", "empty_quote"]);
  });

  it("keeps good evidence and drops bad evidence from the same list", () => {
    const r = verifyEvidence(
      [
        { utterance_id: "s1", quote: "Back home I was an accountant" },
        { utterance_id: "s1", quote: "I was a doctor" },
      ],
      utterances,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
  });

  it("keeps one copy of an exact repeat without counting it as a failure", () => {
    const e = { utterance_id: "s1", quote: "it's fine" };
    const r = verifyEvidence([e, e], utterances);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });
});

describe("immigration status guard", () => {
  it("catches specific status names in the model's wording", () => {
    for (const s of [
      "The student is on an F-1 and worried",
      "Concern about OPT timing",
      "Holds a green card",
      "They are undocumented",
      "H-1B sponsorship fear",
      "DACA recipient",
      "may have overstayed",
    ]) {
      expect(mentionsImmigrationStatus(s), s).toBe(true);
    }
  });

  it("does not flag visa fear, confusion or ordinary words", () => {
    for (const s of [
      "Fear of losing the ability to stay",
      "Unclear on what work is allowed",
      "Work-hour limits blocking a job offer",
      "The student chose to opt out of the group",
      "Worried about a visa rule they heard from a friend",
    ]) {
      expect(mentionsImmigrationStatus(s), s).toBe(false);
    }
  });
});
