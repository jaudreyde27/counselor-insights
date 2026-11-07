import { readFileSync } from "node:fs";
import path from "node:path";
import type { Criteria } from "../criteria";

export const DEFAULT_PROMPT_VERSION = "v3";

/** PROMPT_VERSION=v3 selects prompts/v3/. A bare number like "3" also means v3. */
export function promptVersion(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.PROMPT_VERSION ?? DEFAULT_PROMPT_VERSION).trim();
  return /^\d+$/.test(v) ? `v${v}` : v;
}

function readPrompt(version: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error("Invalid PROMPT_VERSION.");
  return readFileSync(/* turbopackIgnore: true */ path.resolve(process.cwd(), "prompts", version, name), "utf8");
}

/** The taxonomy as text for the prompt: domains, groups and sub-drivers with their ids. */
export function renderTaxonomy(criteria: Criteria): string {
  const lines: string[] = [];
  for (const d of criteria.domains) {
    lines.push(`### ${d.label}${d.tagline ? ` (${d.tagline})` : ""}`);
    let lastGroup: string | null | undefined;
    for (const s of criteria.sub_drivers.filter((x) => x.domain_id === d.id)) {
      if (s.group && s.group !== lastGroup) lines.push(`Group: ${s.group}`);
      lastGroup = s.group;
      lines.push(`- ${s.id}: ${s.label}${s.description ? `. ${s.description}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Classification rules are passed word for word. */
export function renderRules(criteria: Criteria): string {
  return criteria.classification_rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
}

export function call1SystemPrompt(criteria: Criteria, version = promptVersion()): string {
  return readPrompt(version, "call1_themes.md")
    .replace("{{TAXONOMY}}", () => renderTaxonomy(criteria))
    .replace("{{RULES}}", () => renderRules(criteria));
}

export function call2SystemPrompt(version = promptVersion()): string {
  return readPrompt(version, "call2_recommendations.md");
}
