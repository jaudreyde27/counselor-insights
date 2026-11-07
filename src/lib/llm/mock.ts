import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { normalizeForQuote } from "../analysis/verify";
import type { Call1Output, Call2Output } from "../analysis/types";
import { KEYWORD_RULES } from "./mock-rules";
import type { LlmClient, LlmRequest } from "./types";

interface CannedFixture {
  name: string;
  fingerprint: string;
  call1: {
    themes: Array<{
      sub_driver_id: string;
      other_label?: string | null;
      title: string;
      interpretation: string;
      evidence: Array<{ quote: string }>;
    }>;
  };
  call2: {
    recommendations: Array<{
      topic: string;
      open_question: string;
      suggested_approach: string;
      based_on_titles: string[];
    }>;
  };
}

interface PromptUtterance {
  id: string;
  speaker: string;
  text: string;
}

interface ThemeForCall2 {
  theme_id: string;
  domain: string;
  sub_driver: string;
  title: string;
}

let cache: CannedFixture[] | undefined;

const fingerprintOf = (texts: string[]) => normalizeForQuote(texts.join(" "));

/** Reads fixtures/transcripts/*.json and the hand-written results in fixtures/mock/*.json. */
function loadCanned(): CannedFixture[] {
  if (cache) return cache;
  const root = path.resolve(process.cwd(), "fixtures");
  const out: CannedFixture[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(/* turbopackIgnore: true */ path.join(root, "mock")).filter((f) => f.endsWith(".json"));
  } catch {
    // No fixtures folder (for example in a deployed build): only the keyword fallback is used.
  }
  for (const file of files) {
    const transcript = JSON.parse(readFileSync(/* turbopackIgnore: true */ path.join(root, "transcripts", file), "utf8")) as Array<{ text: string }>;
    const canned = JSON.parse(readFileSync(/* turbopackIgnore: true */ path.join(root, "mock", file), "utf8"));
    out.push({ name: file, fingerprint: fingerprintOf(transcript.map((t) => t.text)), ...canned });
  }
  cache = out;
  return out;
}

/** Finds the first student utterance that contains the quote (whole words, normalized). */
function findStudentUtterance(quote: string, utterances: PromptUtterance[]): PromptUtterance | undefined {
  const q = normalizeForQuote(quote);
  return utterances.find((u) => u.speaker === "student" && ` ${normalizeForQuote(u.text)} `.includes(` ${q} `));
}

/** First sentence of an utterance that contains `needle` (case-insensitive), as an exact substring. */
function sentenceContaining(text: string, needle: string): string | undefined {
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  return sentences.map((s) => s.trim()).find((s) => s.toLowerCase().includes(needle));
}

function mockCall1(utterances: PromptUtterance[]): Call1Output {
  const fp = fingerprintOf(utterances.map((u) => u.text));
  const canned = loadCanned().find((c) => c.fingerprint === fp);

  if (canned) {
    const resolve = (items: Array<{ quote: string }>) =>
      items.flatMap(({ quote }) => {
        const u = findStudentUtterance(quote, utterances);
        return u ? [{ utterance_id: u.id, quote }] : [];
      });
    return {
      // Like a real model, only report a theme if a student line can be quoted for it
      // (for example, after "Swap speakers" the canned quotes may no longer sit on student lines).
      themes: canned.call1.themes
        .map((t) => ({
          sub_driver_id: t.sub_driver_id,
          other_label: t.other_label ?? null,
          title: t.title,
          interpretation: t.interpretation,
          evidence: resolve(t.evidence),
        }))
        .filter((t) => t.evidence.length > 0),
    };
  }

  // Keyword fallback for any other pasted text.
  const students = utterances.filter((u) => u.speaker === "student");
  const themes: Call1Output["themes"] = [];
  for (const rule of KEYWORD_RULES) {
    for (const u of students) {
      const keyword = rule.keywords.find((k) => u.text.toLowerCase().includes(k));
      const quote = keyword && sentenceContaining(u.text, keyword);
      if (quote) {
        themes.push({
          sub_driver_id: rule.sub_driver_id,
          other_label: null,
          title: `${rule.title} (mock)`,
          interpretation: "Mock output from keyword matching. The student's words may point to this; a real model would say more.",
          evidence: [{ utterance_id: u.id, quote }],
        });
        break;
      }
    }
    if (themes.length >= 4) break; // a short list, like the real analysis
  }
  return { themes };
}

const FALLBACK_BY_DOMAIN: Record<string, (label: string) => { topic: string; open: string; approach: string }> = {
  "Emotional Burden": (l) => ({
    topic: `Make room to talk about how ${l.toLowerCase()} feels`,
    open: "What has that been like for you lately?",
    approach: "Let the student describe the feeling in their own words before moving to solutions.",
  }),
  "Skill & Knowledge Gaps": (l) => ({
    topic: `Help build know-how around ${l.toLowerCase()}`,
    open: "What have you tried so far, and what was unclear?",
    approach: "Teach the basics, or point to a resource, and check back next session.",
  }),
  "External Barriers": (l) => ({
    topic: `Look at what is blocking the student around ${l.toLowerCase()}`,
    open: "What would make this easier for you right now?",
    approach: "Help them navigate, refer or advocate with the right office or person.",
  }),
};

function mockCall2(thisSession: ThemeForCall2[], earlier: Array<{ sub_driver: string }>): Call2Output {
  // Hand-written recommendations: use a fixture whose recommendation titles all appear in this input.
  const titles = new Set(thisSession.map((t) => t.title));
  let best: Call2Output["recommendations"] = [];
  for (const c of loadCanned()) {
    const matches = c.call2.recommendations.filter((r) => r.based_on_titles.every((t) => titles.has(t)));
    if (matches.length > best.length) {
      best = matches.map((r) => ({
        topic: r.topic,
        open_question: r.open_question,
        suggested_approach: r.suggested_approach,
        based_on_theme_ids: r.based_on_titles.map((t) => thisSession.find((x) => x.title === t)!.theme_id),
      }));
    }
  }

  if (best.length === 0) {
    best = thisSession.slice(0, 2).map((t) => {
      const make = FALLBACK_BY_DOMAIN[t.domain] ?? FALLBACK_BY_DOMAIN["Emotional Burden"];
      const r = make(t.sub_driver);
      return {
        topic: `${r.topic} (mock)`,
        open_question: r.open,
        suggested_approach: r.approach,
        based_on_theme_ids: [t.theme_id],
      };
    });
  }

  const changes: string[] = [];
  if (earlier.length > 0) {
    const before = new Set(earlier.map((e) => e.sub_driver));
    const now = new Set(thisSession.map((t) => t.sub_driver));
    for (const s of now) if (!before.has(s)) changes.push(`${s} came up this session but not before.`);
    for (const s of before) if (!now.has(s)) changes.push(`${s} came up before but not this session.`);
  }
  return { recommendations: best.slice(0, 2), changes_since_earlier_sessions: changes.slice(0, 4) };
}

/**
 * The fake AI used for local work and tests (LLM_MODE=mock). No network, no AWS.
 * Hand-written results for the built-in fixtures; keyword matching for anything else.
 */
export class MockLlmClient implements LlmClient {
  readonly modelId: string = "mock";

  async completeJson(req: LlmRequest): Promise<unknown> {
    const input = JSON.parse(req.user);
    if (req.schemaName === "report_themes") return mockCall1(input.utterances);
    return mockCall2(input.this_session, input.earlier_sessions ?? []);
  }
}
