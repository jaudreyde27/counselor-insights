"use client";

import { useState } from "react";

/**
 * A button that asks "are you sure?" INSIDE the page, then sends one plain request to our own server and moves on.
 * Replaces two earlier versions that did nothing on the deployed site (2026-11-07): the browser's confirm() box
 * (some browsers block it) and a form action on a server-rendered page. A plain fetch to an API route has neither problem.
 */
export function ConfirmButton({
  message,
  confirmLabel = "Yes, continue",
  url,
  method,
  then,
  className,
  children,
}: {
  message: string;
  confirmLabel?: string;
  /** The API route to call, e.g. /api/students/<id>. */
  url: string;
  method: "POST" | "DELETE";
  /** Where to go once it worked. */
  then: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<"idle" | "asking" | "working">("idle");
  const [error, setError] = useState("");

  async function run() {
    setState("working");
    setError("");
    try {
      const res = await fetch(url, { method, credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      window.location.assign(then);
    } catch {
      setError("That did not work. Please try again.");
      setState("asking");
    }
  }

  if (state === "idle") {
    return (
      <button type="button" className={className} onClick={() => setState("asking")}>
        {children}
      </button>
    );
  }

  return (
    <span role="alertdialog" aria-label={message} className="inline-flex flex-wrap items-center justify-center gap-2 text-sm text-ink">
      <span>{message}</span>
      <button
        type="button"
        autoFocus
        disabled={state === "working"}
        onClick={run}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-dark disabled:opacity-60"
      >
        {state === "working" ? "Working…" : confirmLabel}
      </button>
      <button type="button" disabled={state === "working"} onClick={() => setState("idle")} className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-canvas">
        Cancel
      </button>
      {error && <span role="alert" className="w-full text-center text-red-700">{error}</span>}
    </span>
  );
}
