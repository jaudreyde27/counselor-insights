import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { SectionCard, SmallCaps, secondaryButton } from "@/components/ui";

// Shown for pages that do not exist, and also for another counselor's student or session
// (the database hides those rows, so they look exactly like missing ones).
export default function NotFound() {
  return (
    <AppShell>
      <div className="mx-auto max-w-md">
        <SectionCard>
          <SmallCaps accent>Not found</SmallCaps>
          <h1 className="mt-1 text-2xl font-semibold">We can&apos;t find that page</h1>
          <p className="mt-2 text-sm text-muted">It may have been deleted, or it may not be in your account.</p>
          <Link href="/students" className={`${secondaryButton} mt-4`}>
            Back to students
          </Link>
        </SectionCard>
      </div>
    </AppShell>
  );
}
