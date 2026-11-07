import Link from "next/link";
import type { ReactNode } from "react";
import { signOutAction } from "@/app/actions";
import { authMode } from "@/lib/auth/dev";
import { initial } from "@/lib/data/format";
import { Chip } from "./ui";

const appName = () => process.env.APP_NAME ?? "International Student Counseling";

/** Header, page container and footer (SPEC.md 7.3). */
export function AppShell({
  counselor,
  children,
  wide = true,
}: {
  counselor?: { displayName: string };
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between border-b border-line bg-surface px-4">
        <Link href="/students" className="flex min-w-0 items-center gap-2">
          <span className="h-3.5 w-3.5 shrink-0 rounded-full bg-accent" aria-hidden />
          <span className="truncate text-sm font-semibold sm:text-lg">{appName()}</span>
        </Link>
        {counselor && (
          <div className="flex shrink-0 items-center gap-3 pl-3">
            {authMode() === "dev" && (
              <span className="hidden sm:inline-flex">
                <Chip>Dev login</Chip>
              </span>
            )}
            <span className="hidden text-sm sm:inline">{counselor.displayName}</span>
            <span
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-dark"
              aria-hidden
            >
              {initial(counselor.displayName)}
            </span>
            <form action={signOutAction}>
              <button className="whitespace-nowrap text-xs text-muted hover:underline">Sign out</button>
            </form>
          </div>
        )}
      </header>
      <main className={`mx-auto w-full flex-1 px-4 py-6 sm:px-6 ${wide ? "max-w-screen-2xl" : "max-w-xl"}`}>{children}</main>
      <footer className="border-t border-line bg-surface py-3 text-center text-xs text-muted">
        Prototype
      </footer>
    </div>
  );
}
