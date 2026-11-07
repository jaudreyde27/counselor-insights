import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEGREE_TYPES, SCHOOLS, degreeLabel, isDegreeType, isSchool } from "@/lib/student-options";
import { setupTestDb, type TestDb } from "./helpers/db";

describe("school and degree options", () => {
  it("every school starts with Stanford, and there are the five the owner asked for", () => {
    expect(SCHOOLS).toEqual([
      "Stanford Graduate School of Business",
      "Stanford School of Engineering",
      "Stanford School of Medicine",
      "Stanford School of Law",
      "Stanford Undergraduate",
    ]);
    for (const s of SCHOOLS) expect(s.startsWith("Stanford ")).toBe(true);
  });

  it("only accepts listed schools (the old names without Stanford are no longer valid)", () => {
    for (const s of SCHOOLS) expect(isSchool(s)).toBe(true);
    for (const old of ["School of Engineering", "School of Law", "Undergraduate", "Harvard", ""]) {
      expect(isSchool(old), old).toBe(false);
    }
  });

  it("degree types are Bachelors and Masters", () => {
    expect(DEGREE_TYPES.map((d) => d.label)).toEqual(["Bachelors", "Masters"]);
    expect(isDegreeType("bachelors") && isDegreeType("masters")).toBe(true);
    expect(isDegreeType("doctorate")).toBe(false);
    expect(degreeLabel("masters")).toBe("Masters");
  });
});

describe("database columns after the owner's changes", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  const columns = async (table: string) =>
    (await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [table])).rows.map(
      (r) => r.column_name as string,
    );

  it("sessions have no notes column; students keep their key notes", async () => {
    expect(await columns("sessions")).not.toContain("notes");
    const students = await columns("students");
    expect(students).toContain("notes");
    expect(students).toEqual(expect.arrayContaining(["school", "degree_type", "program_of_study", "country_of_origin"]));
    expect(students).not.toContain("graduation_year");
  });

  it("there is no crisis table or column", async () => {
    expect((await db.admin.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'crisis_evidence'")).rowCount).toBe(0);
    expect(await columns("analysis_runs")).not.toContain("crisis_flag");
  });
});
