import { redirect } from "next/navigation";
import { devSignInAction } from "@/app/actions";
import { AppShell } from "@/components/AppShell";
import { SectionCard, SmallCaps, primaryButton } from "@/components/ui";
import { authMode, DEV_COUNSELORS, getCurrentCounselor } from "@/lib/auth";

// Plain messages for the short codes /auth/callback sends back. Never any detail from Cognito.
const ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "That sign-in took too long or was not started here. Please try again.",
  failed: "We could not sign you in. Please try again, or ask for your account to be checked.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getCurrentCounselor()) redirect("/students");
  const { error } = await searchParams;
  const mode = authMode();

  return (
    <AppShell>
      <div className="mx-auto max-w-md">
        <SectionCard>
          <SmallCaps accent>Counselor account</SmallCaps>
          <h1 className="mt-1 text-2xl font-semibold">Sign in</h1>

          {error && ERRORS[error] && (
            <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {ERRORS[error]}
            </p>
          )}

          {mode === "cognito" && (
            <>
              <p className="mt-3 text-sm text-muted">
                Accounts are created for you by an administrator. Sign in on the next page with your email and password.
              </p>
              {/* A plain link, not a form: the sign-in starts with a redirect to Cognito's hosted page. */}
              <a href="/auth/login" className={`${primaryButton} mt-4 w-full`}>
                Sign in
              </a>
            </>
          )}

          {mode === "dev" && (
            <>
              <p className="mt-3 rounded-lg bg-accent-soft p-3 text-sm text-muted">
                <span className="font-semibold text-ink">Development login.</span> These are fake counselors for local
                work. The real sign-in (AWS Cognito) is used when the app is deployed, and this one cannot be switched on
                in a deployed build.
              </p>
              <div className="mt-4 space-y-2">
                {DEV_COUNSELORS.map((d) => (
                  <form key={d.sub} action={devSignInAction}>
                    <input type="hidden" name="sub" value={d.sub} />
                    <button className={`${primaryButton} w-full`}>Sign in as {d.displayName}</button>
                  </form>
                ))}
              </div>
            </>
          )}

          {mode === "off" && <p className="mt-3 text-sm text-muted">Sign-in is not configured.</p>}
        </SectionCard>
      </div>
    </AppShell>
  );
}
