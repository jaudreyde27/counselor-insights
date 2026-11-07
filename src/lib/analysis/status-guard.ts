/**
 * Safety net for the hard rule "never record an actual immigration status"
 * (SPEC.md 6.2). The prompt tells the model not to; this catches it if it does
 * anyway. It looks only for specific status names in the model's own wording
 * (titles, interpretations, recommendations), never in the student's quotes.
 * Visa fear or confusion is fine and is NOT matched here.
 */
const STATUS_PATTERNS: RegExp[] = [
  /\b[fjhlmo]-?\d[a-z]?\b/i, // F-1, J-1, H-1B, L-1, M-1, O-1 and F1/J1/H1B forms
  /\b(?:OPT|CPT|STEM[- ]OPT)\b/, // uppercase only, so the ordinary word "opt" is not flagged
  /\bgreen[- ]?card\b/i,
  /\bpermanent resident\b/i,
  /\bundocumented\b/i,
  /\bdaca\b/i,
  /\basylum\b/i,
  /\brefugee\b/i,
  /\bout of status\b/i,
  /\boverstay(?:ed|ing)?\b/i,
  /\bstudent visa holder\b/i,
];

export function mentionsImmigrationStatus(text: string): boolean {
  return STATUS_PATTERNS.some((re) => re.test(text));
}
