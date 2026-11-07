"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-reads the page from the server every couple of seconds while something is processing. */
export function AutoRefresh({ everyMs = 2000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
