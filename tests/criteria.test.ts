import { describe, expect, it } from "vitest";
import { loadCriteria, parseCriteria } from "@/lib/criteria";

const seeded = loadCriteria();

describe("criteria loader: seeded config/criteria.json", () => {
  it("has the version and the three domains from Appendix A", () => {
    expect(seeded.version).toBe("1.1");
    expect(seeded.domains.map((d) => d.id)).toEqual([
      "emotional_burden",
      "skill_knowledge_gaps",
      "external_barriers",
    ]);
  });

  it("has every sub-driver (8 + 9 + 13) and each belongs to a real domain", () => {
    const count = (d: string) => seeded.sub_drivers.filter((s) => s.domain_id === d).length;
    expect(count("emotional_burden")).toBe(8);
    expect(count("skill_knowledge_gaps")).toBe(9);
    expect(count("external_barriers")).toBe(13);
    for (const s of seeded.sub_drivers) expect(seeded.domain(s.domain_id)).toBeDefined();
  });

  it("uses groups for External Barriers only", () => {
    const groups = new Set(
      seeded.sub_drivers.filter((s) => s.domain_id === "external_barriers").map((s) => s.group),
    );
    expect([...groups].sort()).toEqual(["Career & Network", "People & Community", "Rules & Institutions"]);
    for (const s of seeded.sub_drivers.filter((x) => x.domain_id !== "external_barriers")) {
      expect(s.group ?? null).toBeNull();
    }
  });

  it("carries all seven classification rules, including the visa test case and the buckets rule", () => {
    expect(seeded.classification_rules).toHaveLength(7);
    const buckets = seeded.classification_rules.find((r) => r.startsWith("Buckets:"));
    expect(buckets).toContain("fine for a student to have nothing in some of the three domains");
    expect(buckets).toContain("only Emotional Burden, or only External Barriers");
    expect(seeded.classification_rules.join(" ")).not.toMatch(/crisis|safety/i);
    expect(seeded.classification_rules.join("\n")).toContain("Visa test case");
  });

  it("looks up sub-drivers and domains by id", () => {
    expect(seeded.subDriver("homesickness_grief")?.label).toBe("Homesickness and grief");
    expect(seeded.subDriver("visa_work_restrictions")?.domain_id).toBe("external_barriers");
    expect(seeded.subDriver("nope")).toBeUndefined();
  });
});

describe("criteria loader: editing without code changes", () => {
  const minimal = {
    version: "2.0",
    domains: [{ id: "d1", label: "Domain one" }],
    sub_drivers: [{ id: "s1", domain_id: "d1", label: "Sub one" }],
    classification_rules: ["Rule one"],
  };

  it("accepts a different, edited list", () => {
    const c = parseCriteria({
      ...minimal,
      sub_drivers: [
        ...minimal.sub_drivers,
        { id: "s2", domain_id: "d1", label: "Sub two", group: "New group" },
      ],
    });
    expect(c.sub_drivers.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(c.version).toBe("2.0");
  });

  it("accepts and keeps extra fields", () => {
    const c = parseCriteria({
      ...minimal,
      owner: "Troy",
      domains: [{ id: "d1", label: "Domain one", color: "orange" }],
      sub_drivers: [{ id: "s1", domain_id: "d1", label: "Sub one", examples: ["a", "b"] }],
    });
    expect((c as Record<string, unknown>).owner).toBe("Troy");
    expect((c.domains[0] as Record<string, unknown>).color).toBe("orange");
    expect((c.sub_drivers[0] as Record<string, unknown>).examples).toEqual(["a", "b"]);
  });

  it("rejects a sub-driver that points at an unknown domain", () => {
    expect(() =>
      parseCriteria({ ...minimal, sub_drivers: [{ id: "s1", domain_id: "missing", label: "x" }] }),
    ).toThrow(/unknown domain/);
  });

  it("rejects duplicate ids and the reserved id 'other'", () => {
    expect(() =>
      parseCriteria({
        ...minimal,
        sub_drivers: [
          { id: "s1", domain_id: "d1", label: "a" },
          { id: "s1", domain_id: "d1", label: "b" },
        ],
      }),
    ).toThrow(/duplicate sub-driver/);
    expect(() =>
      parseCriteria({ ...minimal, sub_drivers: [{ id: "other", domain_id: "d1", label: "x" }] }),
    ).toThrow(/reserved/);
  });
});
