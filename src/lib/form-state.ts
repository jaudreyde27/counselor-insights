/** What a form action returns when something needs fixing. (Success redirects instead.) */
export type FormState = { error?: string; values?: Record<string, string> } | undefined;
