"use client";

import { useState, type ButtonHTMLAttributes } from "react";

/**
 * A submit button that asks "are you sure?" first, INSIDE the page (SPEC.md 7.6 said the browser's confirm() box).
 * The browser box was replaced because some browsers silently block it, and then the button did nothing at all
 * (found on the first real deploy, 2026-11-07). The first click shows the question with two buttons; only the
 * confirming button submits the form.
 */
export function ConfirmButton({
  message,
  confirmLabel = "Yes, continue",
  children,
  className,
  ...props
}: { message: string; confirmLabel?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <button {...props} className={className} type="button" onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }

  return (
    <span role="alertdialog" aria-label={message} className="inline-flex flex-wrap items-center justify-center gap-2 text-sm text-ink">
      <span>{message}</span>
      <button
        {...props}
        type="submit"
        autoFocus
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-dark"
      >
        {confirmLabel}
      </button>
      <button type="button" onClick={() => setAsking(false)} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-canvas">
        Cancel
      </button>
    </span>
  );
}
