import { describe, expect, it } from "vitest";
import { AnalysisError, analyzeTranscript } from "@/lib/analysis/analyze";
import { mentionsImmigrationStatus } from "@/lib/analysis/status-guard";
import type { EarlierTheme, Utterance } from "@/lib/analysis/types";
import { loadCriteria } from "@/lib/criteria";
import type { LlmClient } from "@/lib/llm";
import { MockLlmClient } from "@/lib/llm/mock";
import { FIXTURE_NAMES, ScriptedLlm, loadFixture } from "./helpers/llm";

const criteria = loadCriteria();
const mock = new MockLlmClient();
const run = (utterances: Utterance[], llm: LlmClient = mock, earlierThemes: EarlierTheme[] = []) =>
  analyzeTranscript({ utterances, earlierThemes }, { llm, criteria, promptVersion: "v3", temperature: 0 });

const fixture = (prefix: string) => FIXTURE_NAMES.find((n) => n.startsWith(prefix))!;

describe("fixtures through the mock pipeline", () => {
  it("has the fixtures the spec asks for", () => {
    expect(FIXTURE_NAMES.length).toBeGreaterThanOrEqual(5);
  });

  for (const name of FIXTURE_NAMES) {
    it(`${name}: every theme quote is verified, recommendations point at real themes`, async () => {
      const utterances = loadFixture(name);
      const r = await run(utterances);
      const byId = new Map(utterances.map((u) => [u.id, u]));

      expect(r.themes.length).toBeGreaterThan(0);
      expect(r.dropped_quote_count).toBe(0);
      expect(r.dropped_theme_count).toBe(0);
      for (const t of r.themes) {
        expect(t.evidence.length).toBeGreaterThan(0);
        for (const e of t.evidence) {
          expect(byId.get(e.utterance_id)?.speaker).toBe("student");
          expect(byId.get(e.utterance_id)!.text).toContain(e.quote.replace(/\.$/, "").slice(0, 12));
        }
        // domain is copied from the config, never made up
        if (t.sub_driver_id !== "other") expect(t.domain_id).toBe(criteria.subDriver(t.sub_driver_id)!.domain_id);
      }
      expect(r.recommendations.length).toBeGreaterThan(0);
      expect(r.recommendations.length).toBeLessThanOrEqual(2);
      const ids = new Set(r.themes.map((t) => t.id));
      for (const rec of r.recommendations) {
        expect(rec.based_on_theme_ids.length).toBeGreaterThan(0);
        for (const id of rec.based_on_theme_ids) expect(ids.has(id)).toBe(true);
      }
      expect(r.changes_since_earlier_sessions).toEqual([]); // first session
    });
  }

  it("reports only themes that came up (no 'not present' results)", async () => {
    const r = await run(loadFixture(fixture("01")));
    expect(r.themes.map((t) => t.sub_driver_id).sort()).toEqual(
      ["career_norms", "homesickness_grief", "loneliness"].sort(),
    );
    expect(r.themes.some((t) => t.domain_id === "external_barriers")).toBe(false);
  });

  it("visa fear: themes in all three domains, and one statement supports themes in two domains", async () => {
    const r = await run(loadFixture(fixture("02")));
    expect(new Set(r.themes.map((t) => t.domain_id))).toEqual(
      new Set(["emotional_burden", "skill_knowledge_gaps", "external_barriers"]),
    );
    const subs = r.themes.map((t) => t.sub_driver_id);
    expect(subs).toEqual(expect.arrayContaining(["fear_anxiety", "visa_work_rules", "visa_work_restrictions"]));

    const domainsPerUtterance = new Map<string, Set<string>>();
    for (const t of r.themes) {
      for (const e of t.evidence) {
        domainsPerUtterance.set(e.utterance_id, (domainsPerUtterance.get(e.utterance_id) ?? new Set()).add(t.domain_id));
      }
    }
    expect([...domainsPerUtterance.values()].some((d) => d.size >= 2)).toBe(true);
  });

  it("housing conflict: only the major themes, in two of the three buckets (nothing in Skill & Knowledge Gaps)", async () => {
    const r = await run(loadFixture(fixture("03")));
    expect(r.themes.map((t) => t.sub_driver_id).sort()).toEqual(["financial_strain", "interpersonal_conflict", "loneliness"]);
    expect(new Set(r.themes.map((t) => t.domain_id))).toEqual(new Set(["emotional_burden", "external_barriers"]));
    expect(r.themes.some((t) => t.domain_id === "skill_knowledge_gaps")).toBe(false);
  });

  it("themes can fall in just one bucket, or in any mix of buckets", async () => {
    const domains = async (prefix: string) =>
      [...new Set((await run(loadFixture(fixture(prefix)))).themes.map((t) => t.domain_id))].sort();
    expect(await domains("04")).toEqual(["other", "skill_knowledge_gaps"]); // a theme outside the taxonomy plus one skill gap
    expect(await domains("05")).toEqual(["emotional_burden", "external_barriers"]);
    // one bucket only
    const llm = new ScriptedLlm({
      report_themes: [
        {
          themes: [
            {
              sub_driver_id: "financial_strain",
              other_label: null,
              title: "Rent is a heavy worry",
              interpretation: "The student may be under steady money pressure.",
              evidence: [{ utterance_id: "s1", quote: "Rent is hard to afford" }],
            },
          ],
        },
      ],
      report_recommendations: [{ recommendations: [], changes_since_earlier_sessions: [] }],
    });
    const only = await run(
      [
        { id: "c1", speaker: "counselor", text: "How are things?" },
        { id: "s1", speaker: "student", text: "Rent is hard to afford this month." },
      ],
      llm,
    );
    expect(only.themes.map((t) => t.domain_id)).toEqual(["external_barriers"]);
    expect(only.dropped_theme_count).toBe(0);
  });

  it("a theme outside the taxonomy uses 'other' with a label", async () => {
    const r = await run(loadFixture(fixture("04")));
    const other = r.themes.find((t) => t.sub_driver_id === "other")!;
    expect(other.other_label).toBe("Religious practice and observance");
    expect(other.domain_id).toBe("other");
    expect(other.evidence.length).toBeGreaterThan(0);
  });

  it("a stated immigration status never appears in any theme, recommendation or note", async () => {
    const utterances = loadFixture(fixture("05"));
    expect(utterances.some((u) => /F-1/.test(u.text))).toBe(true); // the transcript does state it
    const r = await run(utterances);
    const everything = JSON.stringify({
      themes: r.themes.map((t) => [t.title, t.interpretation, t.other_label]),
      recs: r.recommendations,
      changes: r.changes_since_earlier_sessions,
    });
    expect(mentionsImmigrationStatus(everything)).toBe(false);
    expect(everything).not.toMatch(/F-1|OPT|visa status/);
    // and the quotes chosen are not the ones that state it
    for (const t of r.themes) for (const e of t.evidence) expect(e.quote).not.toMatch(/F-1|OPT/);
    expect(r.themes.map((t) => t.sub_driver_id)).toContain("job_market_access");
  });
});

describe("mock keyword fallback for text that is not a fixture", () => {
  it("finds themes with real, verified quotes", async () => {
    const utterances: Utterance[] = [
      { id: "a", speaker: "counselor", text: "How are things?" },
      { id: "b", speaker: "student", text: "I am so tired. I miss my grandmother a lot." },
      { id: "c", speaker: "student", text: "Rent is hard to afford this month." },
    ];
    const r = await run(utterances);
    expect(r.themes.length).toBeGreaterThan(0);
    expect(r.dropped_quote_count).toBe(0);
    expect(r.themes.every((t) => t.title.includes("(mock)"))).toBe(true);
    expect(r.themes.map((t) => t.sub_driver_id)).toEqual(expect.arrayContaining(["exhaustion_burnout", "financial_strain"]));
  });

  it("returns no themes, and skips call 2, when nothing matches", async () => {
    const r = await run([{ id: "a", speaker: "student", text: "Hello." }]);
    expect(r.themes).toEqual([]);
    expect(r.recommendations).toEqual([]);
  });
});

describe("pipeline safeguards (scripted model)", () => {
  const u: Utterance[] = [
    { id: "c1", speaker: "counselor", text: "What is on your mind?" },
    { id: "s1", speaker: "student", text: "I feel very alone and I miss home." },
    { id: "s2", speaker: "student", text: "Money is tight." },
  ];
  const theme = (over = {}) => ({
    sub_driver_id: "loneliness",
    other_label: null,
    title: "Feeling alone",
    interpretation: "The student may feel alone.",
    evidence: [{ utterance_id: "s1", quote: "I feel very alone" }],
    ...over,
  });
  const call1 = (themes: unknown[]) => ({ themes });
  const recs = (ids: string[], extra = {}) => ({
    recommendations: [{ topic: "t", open_question: "q?", suggested_approach: "a", based_on_theme_ids: ids }],
    changes_since_earlier_sessions: [],
    ...extra,
  });

  it("drops an invented quote and counts it; a theme with no valid quote is dropped", async () => {
    const llm = new ScriptedLlm({
      report_themes: [
        call1([
          theme({ evidence: [{ utterance_id: "s1", quote: "I feel very alone" }, { utterance_id: "s1", quote: "I never speak to anyone" }] }),
          theme({ sub_driver_id: "financial_strain", title: "Money", evidence: [{ utterance_id: "s2", quote: "Rent is due Friday" }] }),
        ]),
      ],
      report_recommendations: [recs(["x"])],
    });
    const r = await run(u, llm);
    expect(r.themes).toHaveLength(1);
    expect(r.themes[0].evidence).toHaveLength(1);
    expect(r.dropped_quote_count).toBe(2);
    expect(r.dropped_theme_count).toBe(1);
  });

  it("drops a theme whose only quote is from the counselor", async () => {
    const llm = new ScriptedLlm({
      report_themes: [call1([theme({ evidence: [{ utterance_id: "c1", quote: "What is on your mind" }] })])],
    });
    const r = await run(u, llm);
    expect(r.themes).toEqual([]);
    expect(r.dropped_quote_count).toBe(1);
  });

  it("drops a theme with an unknown sub-driver id", async () => {
    const llm = new ScriptedLlm({ report_themes: [call1([theme({ sub_driver_id: "made_up_driver" })])] });
    const r = await run(u, llm);
    expect(r.themes).toEqual([]);
    expect(r.dropped_theme_count).toBe(1);
  });

  it("labels an 'other' theme with no label as 'Other'", async () => {
    const llm = new ScriptedLlm({
      report_themes: [call1([theme({ sub_driver_id: "other", other_label: null })])],
      report_recommendations: [recs(["x"])],
    });
    const r = await run(u, llm);
    expect(r.themes[0].other_label).toBe("Other");
  });

  it("drops a theme whose title or interpretation states an immigration status", async () => {
    const llm = new ScriptedLlm({
      report_themes: [
        call1([theme({ title: "Worry about F-1 work limits" }), theme({ interpretation: "As an undocumented student they fear exposure." })]),
      ],
    });
    const r = await run(u, llm);
    expect(r.themes).toEqual([]);
    expect(r.dropped_theme_count).toBe(2);
  });

  it("drops recommendations that point at themes that do not exist, and keeps at most two", async () => {
    // We do not know the generated theme id up front, so script call 2 from the request itself.
    class DynamicLlm extends ScriptedLlm {
      async completeJson(req: Parameters<ScriptedLlm["completeJson"]>[0]) {
        if (req.schemaName === "report_themes") return super.completeJson(req);
        this.requests.push(req);
        const id = JSON.parse(req.user).this_session[0].theme_id as string;
        const good = { topic: "ok", open_question: "q?", suggested_approach: "a", based_on_theme_ids: [id] };
        return {
          recommendations: [
            { ...good, topic: "bad", based_on_theme_ids: ["not-a-real-theme"] },
            { ...good, topic: "empty", based_on_theme_ids: [] },
            { ...good, topic: "one" },
            { ...good, topic: "two" },
            { ...good, topic: "three" },
          ],
          changes_since_earlier_sessions: ["Something changed."],
        };
      }
    }
    const llm = new DynamicLlm({ report_themes: [call1([theme()])] });
    const r = await run(u, llm);
    expect(r.recommendations.map((x) => x.topic)).toEqual(["one", "two"]);
    expect(r.dropped_recommendation_count).toBe(2);
    expect(r.changes_since_earlier_sessions).toEqual([]); // first session: no earlier sessions to compare
  });

  it("keeps changes_since_earlier_sessions when earlier sessions exist, and passes only themes (no quotes) from them", async () => {
    class DynamicLlm extends ScriptedLlm {
      async completeJson(req: Parameters<ScriptedLlm["completeJson"]>[0]) {
        if (req.schemaName === "report_themes") return super.completeJson(req);
        this.requests.push(req);
        const id = JSON.parse(req.user).this_session[0].theme_id as string;
        return {
          recommendations: [{ topic: "t", open_question: "q?", suggested_approach: "a", based_on_theme_ids: [id] }],
          changes_since_earlier_sessions: ["Money worries came up this session but not before."],
        };
      }
    }
    const llm = new DynamicLlm({ report_themes: [call1([theme()])] });
    const earlier = [
      {
        session_date: "2026-10-01",
        sub_driver_id: "guilt",
        domain_id: "emotional_burden",
        other_label: null,
        title: "Earlier guilt",
        interpretation: "Earlier note.",
      },
    ];
    const r = await run(u, llm, earlier);
    expect(r.changes_since_earlier_sessions).toEqual(["Money worries came up this session but not before."]);
    const call2 = JSON.parse(llm.requests.find((q) => q.schemaName === "report_recommendations")!.user);
    expect(Object.keys(call2.earlier_sessions[0]).sort()).toEqual(
      ["domain", "interpretation", "session_date", "sub_driver", "title"].sort(),
    );
  });

  it("does not call the model a second time when there are no verified themes", async () => {
    const llm = new ScriptedLlm({ report_themes: [call1([])] });
    const r = await run(u, llm);
    expect(r.recommendations).toEqual([]);
    expect(llm.requests.map((q) => q.schemaName)).toEqual(["report_themes"]);
  });

  it("retries once when the reply has the wrong structure, then succeeds", async () => {
    const llm = new ScriptedLlm({
      report_themes: [{ themes: "not a list" }, call1([theme()])],
      report_recommendations: [recs(["x"])],
    });
    const r = await run(u, llm);
    expect(r.themes).toHaveLength(1);
    expect(llm.requests.filter((q) => q.schemaName === "report_themes")).toHaveLength(2);
    // The retry note mentions the problem's location only, not any content.
    expect(llm.requests[1].user).toContain("did not match the required structure");
  });

  it("fails with a clear error code after one retry", async () => {
    const llm = new ScriptedLlm({ report_themes: [{ nonsense: true }] });
    await expect(run(u, llm)).rejects.toMatchObject({ code: "call1_invalid_output" });
    await expect(run(u, new ScriptedLlm({ report_themes: [{ nonsense: true }] }))).rejects.toBeInstanceOf(AnalysisError);
  });

  it("sends the model only transcript text and the taxonomy (call 1)", async () => {
    const llm = new ScriptedLlm({ report_themes: [call1([])] });
    await run(u, llm);
    const req = llm.requests[0];
    expect(Object.keys(JSON.parse(req.user))).toEqual(["utterances"]);
    expect(Object.keys(JSON.parse(req.user).utterances[0]).sort()).toEqual(["id", "speaker", "text"]);
    expect(req.system).toContain("homesickness_grief"); // taxonomy is in the prompt
    expect(req.system).toContain("Visa test case"); // rules are passed word for word
    for (const rule of criteria.classification_rules) expect(req.system).toContain(rule);
    expect(req.temperature).toBe(0);
  });
});

describe("analysis instructions (prompt v3)", () => {
  it("is the default prompt version, and older versions can still be selected", async () => {
    const { promptVersion, DEFAULT_PROMPT_VERSION } = await import("@/lib/analysis/prompts");
    expect(DEFAULT_PROMPT_VERSION).toBe("v3");
    expect(promptVersion({} as never)).toBe("v3");
    expect(promptVersion({ PROMPT_VERSION: "3" } as never)).toBe("v3");
    expect(promptVersion({ PROMPT_VERSION: "2" } as never)).toBe("v2");
    expect(promptVersion({ PROMPT_VERSION: "1" } as never)).toBe("v1"); // older runs can still be reproduced
  });

  it("tells the model to judge importance mainly by the severity of the student's language and sentiment", async () => {
    const { call1SystemPrompt } = await import("@/lib/analysis/prompts");
    const p = call1SystemPrompt(criteria, "v3");
    expect(p).toContain("Report only the most important sources of distress");
    expect(p).toContain("Judge this mainly by the severity of the student's own language and sentiment");
    expect(p).toContain("let the language the student actually used lead");
    // examples of strong versus mild wording are in the instructions
    expect(p).toContain('"I can\'t sleep"');
    expect(p).toContain('"it\'s a bit annoying"');
    // the roommate example still holds, now tied to wording
    expect(p).toContain("if money worries are major (strong wording, real effects) but a disagreement with a roommate is minor (mild wording), report only the money worries");
  });

  it("warns about understatement, and still never outputs a severity label or score", async () => {
    const { call1SystemPrompt } = await import("@/lib/analysis/prompts");
    const p = call1SystemPrompt(criteria, "v3");
    expect(p).toContain("Watch for understatement");
    expect(p).toContain("Do not output a severity label, score or ranking");
    expect(p).toContain("Do not diagnose, label or score anything. Do not give a severity.");
  });

  it("tells the model it is fine to have nothing in some buckets, in the prompt and in the rules", async () => {
    const { call1SystemPrompt } = await import("@/lib/analysis/prompts");
    const p = call1SystemPrompt(criteria, "v3");
    expect(p).toContain("It is fine for a student to have nothing in some of the three domains");
    expect(p).toContain("Never add a theme just to fill a domain");
    expect(p).toContain("Buckets: it is fine for a student to have nothing in some of the three domains"); // from criteria.json, word for word
  });

  it("recommendations favor the themes with the most intense supporting language", async () => {
    const { call2SystemPrompt } = await import("@/lib/analysis/prompts");
    expect(call2SystemPrompt("v3")).toContain("favor the themes whose supporting quotes use the strongest or most emotionally intense language");
    expect(call2SystemPrompt("v2")).not.toContain("most emotionally intense language");
  });

  it("keeps v1 and v2 unchanged so earlier runs stay comparable", async () => {
    const { call1SystemPrompt } = await import("@/lib/analysis/prompts");
    expect(call1SystemPrompt(criteria, "v1")).not.toContain("most important sources of distress");
    const v2 = call1SystemPrompt(criteria, "v2");
    expect(v2).toContain("most important sources of distress");
    expect(v2).not.toContain("severity of the student's own language");
  });
});
