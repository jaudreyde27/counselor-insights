import Link from "next/link";
import type { ReactNode } from "react";
import { formatDate, SESSION_STATUS_LABEL } from "@/lib/data/format";

/* Building blocks that follow SPEC.md section 7 (tokens are in globals.css). */

export type ChipTone = "neutral" | "accent" | "green" | "blue" | "red";

const CHIP: Record<ChipTone, string> = {
  neutral: "bg-stone-100 text-stone-700",
  accent: "bg-accent-soft text-accent-dark",
  green: "bg-emerald-50 text-emerald-700",
  blue: "bg-sky-50 text-sky-700",
  red: "bg-red-50 text-red-700",
};

export function Chip({
  tone = "neutral",
  size = "sm",
  children,
}: {
  tone?: ChipTone;
  /** "md" is the slightly larger bubble used for sub-drivers (for example Institutional bureaucracy). */
  size?: "sm" | "md";
  children: ReactNode;
}) {
  const sizing = size === "md" ? "px-3.5 py-1 text-sm" : "px-2.5 py-0.5 text-xs";
  return <span className={`inline-flex items-center rounded-full font-medium ${sizing} ${CHIP[tone]}`}>{children}</span>;
}

/** Status is always shown with a text label, never by color alone. */
export function StatusChip({ status }: { status: string }) {
  const tone: ChipTone = status === "complete" ? "green" : status === "failed" ? "accent" : "neutral";
  return <Chip tone={tone}>{SESSION_STATUS_LABEL[status] ?? status}</Chip>;
}

export function SmallCaps({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <p className={`text-xs font-semibold uppercase tracking-wide ${accent ? "text-accent-dark" : "text-muted"}`}>
      {children}
    </p>
  );
}

export function SectionCard({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-surface p-5 ${className}`}>
      {title && <h2 className="mb-3 text-lg font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export const primaryButton =
  "inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-60";
export const secondaryButton =
  "inline-flex items-center justify-center rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface";
export const inputClass =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/40";

export function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">
        {label}
        {required && <span className="ml-0.5 text-red-600">*</span>}
      </span>
      {children}
      {help && <span className="mt-1 block text-xs text-muted">{help}</span>}
    </label>
  );
}

/** A quote: 2px accent bar, curly quotes, muted date. Optionally links to its line in the session. */
export function Quote({
  text,
  date,
  href,
  italic = false,
}: {
  text: string;
  date?: string;
  href?: string;
  italic?: boolean;
}) {
  const body = (
    <>
      <span className={italic ? "italic" : ""}>&ldquo;{text}&rdquo;</span>
      {date && <span className="ml-1 text-muted">· {formatDate(date)}</span>}
    </>
  );
  return (
    <blockquote className="border-l-2 border-accent/40 pl-3 text-sm">
      {href ? (
        <Link href={href} className="hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </blockquote>
  );
}

/** Quotes sit behind a collapsed "Evidence (N quotes)" summary. */
export function Evidence({
  quotes,
  sessionId,
  date,
}: {
  quotes: Array<{ quote: string; utterance_idx: number }>;
  sessionId: string;
  date: string;
}) {
  return (
    <details className="mt-4">
      <summary className="cursor-pointer py-1 text-xs text-muted hover:underline">
        Evidence ({quotes.length} {quotes.length === 1 ? "quote" : "quotes"})
      </summary>
      <div className="mt-3 space-y-3 pb-1">
        {quotes.map((q, i) => (
          <Quote key={i} text={q.quote} date={date} href={`/sessions/${sessionId}#u-${q.utterance_idx}`} />
        ))}
      </div>
    </details>
  );
}

export function ProcessingBanner({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-accent/40 bg-accent-soft p-4">
      <span className="mt-1.5 h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-muted">{children}</p>
      </div>
    </div>
  );
}

export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface p-10 text-center">
      <p className="text-sm text-muted">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sm text-muted hover:underline">
      ← {children}
    </Link>
  );
}

export function FunnelIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2 3h12l-4.5 5.5V13l-3-1.5V8.5L2 3z" strokeLinejoin="round" />
    </svg>
  );
}

export function SortIcon({ dir }: { dir: "asc" | "desc" }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d={dir === "desc" ? "M8 3v10M4 9l4 4 4-4" : "M8 13V3M4 7l4-4 4 4"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
