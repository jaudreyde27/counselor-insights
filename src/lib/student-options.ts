/** The Stanford schools a student can belong to. Undergraduate is its own entry. */
export const SCHOOLS = [
  "Stanford Graduate School of Business",
  "Stanford School of Engineering",
  "Stanford School of Medicine",
  "Stanford School of Law",
  "Stanford Undergraduate",
] as const;

export const DEGREE_TYPES = [
  { value: "bachelors", label: "Bachelors" },
  { value: "masters", label: "Masters" },
] as const;

/** Filter choices for the Sessions column. */
export const SESSION_COUNT_FILTERS = [
  { value: "0", label: "No sessions" },
  { value: "1", label: "1 session" },
  { value: "2", label: "2 sessions" },
  { value: "3plus", label: "3 or more" },
] as const;

export type DegreeType = (typeof DEGREE_TYPES)[number]["value"];

export function degreeLabel(value: string): string {
  return DEGREE_TYPES.find((d) => d.value === value)?.label ?? value;
}

export function isSchool(value: string): boolean {
  return (SCHOOLS as readonly string[]).includes(value);
}

export function isDegreeType(value: string): value is DegreeType {
  return DEGREE_TYPES.some((d) => d.value === value);
}
