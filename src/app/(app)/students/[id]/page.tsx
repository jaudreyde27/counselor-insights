import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteStudentAction } from "@/app/actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ConfirmButton } from "@/components/ConfirmButton";
import { AddSessionForm } from "@/components/forms";
import {
  BackLink,
  Chip,
  Evidence,
  ProcessingBanner,
  SectionCard,
  SmallCaps,
  StatusChip,
} from "@/components/ui";
import { requireCounselor } from "@/lib/auth";
import { getCriteria } from "@/lib/criteria";
import { withCounselor } from "@/lib/db";
import { formatDate, processingCopy } from "@/lib/data/format";
import { getStudentView, type ThemeView } from "@/lib/data/students";
import { degreeLabel } from "@/lib/student-options";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StudentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const counselor = await requireCounselor();
  const view = await withCounselor(counselor.id, (c) => getStudentView(c, counselor.id, id));
  if (!view) notFound();

  const criteria = getCriteria();
  const { student, latest, sessions } = view;
  const subLabel = (t: { sub_driver_id: string; other_label: string | null }) =>
    criteria.subDriver(t.sub_driver_id)?.label ?? t.other_label ?? "Other";

  // One card per domain that has themes, in the config's order. "Other" themes get their own card last.
  const domainCards: Array<{ key: string; label: string; themes: ThemeView[] }> = [];
  if (latest) {
    for (const d of criteria.domains) {
      const themes = latest.themes.filter((t) => t.domain_id === d.id);
      if (themes.length) domainCards.push({ key: d.id, label: d.label, themes });
    }
    const other = latest.themes.filter((t) => !criteria.domain(t.domain_id));
    if (other.length) domainCards.push({ key: "other", label: "Other", themes: other });
  }

  return (
    <div className="space-y-6">
      <BackLink href="/students">Students</BackLink>

      {/* The main action on this page, right at the top. */}
      <AddSessionForm studentId={student.id} />

      <SectionCard className="@container">
        <h1 className="text-2xl font-semibold">{student.full_name}</h1>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm @xl:grid-cols-6">
          {[
            ["School", student.school],
            ["Degree", degreeLabel(student.degree_type)],
            ["Program of study", student.program_of_study],
            ["Country", student.country_of_origin],
            ["Sessions", String(student.session_count)],
            ["Last session", formatDate(student.last_session)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt>
                <SmallCaps>{k}</SmallCaps>
              </dt>
              <dd className="mt-0.5">{v}</dd>
            </div>
          ))}
        </dl>
        {student.notes && (
          <div className="mt-4 border-t border-line pt-3">
            <SmallCaps>Key notes</SmallCaps>
            <p className="mt-0.5 whitespace-pre-wrap text-sm">{student.notes}</p>
          </div>
        )}
      </SectionCard>

      {view.processingStatus && (
        <>
          <ProcessingBanner title={processingCopy(view.processingStatus).title}>
            {processingCopy(view.processingStatus).text}
          </ProcessingBanner>
          <AutoRefresh />
        </>
      )}

      <div className="@container">
      <div className="grid gap-6 @4xl:grid-cols-[3fr_2fr]">
        {/* ------------------------------------------------ left: student profile */}
        <SectionCard title="Student profile" className="self-start">
          {!latest ? (
            <p className="text-sm text-muted">No analysis yet. Results appear here once a session has been analyzed.</p>
          ) : latest.themes.length === 0 ? (
            <p className="text-sm text-muted">No themes came up in the most recent session ({formatDate(latest.session_date)}).</p>
          ) : (
            <div className="space-y-5">
              <div className="rounded-lg bg-accent-soft p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-accent-dark">
                  Themes in the most recent session · {formatDate(latest.session_date)}
                </p>
                <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm">
                  {latest.themes.map((t) => (
                    <li key={t.id}>{t.title}</li>
                  ))}
                </ul>
              </div>

              {domainCards.map((d) => (
                <div key={d.key} className="rounded-lg border border-line p-5">
                  <SmallCaps>{d.label}</SmallCaps>
                  <div className="mt-4 divide-y divide-line">
                    {d.themes.map((t) => (
                      <div key={t.id} className="py-5 first:pt-0 last:pb-0">
                        <Chip size="md">{subLabel(t)}</Chip>
                        <h3 className="mt-3 font-semibold">{t.title}</h3>
                        <p className="mt-1.5 text-sm leading-relaxed">{t.interpretation}</p>
                        <Evidence quotes={t.evidence} sessionId={latest.session_id} date={latest.session_date} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* ------------------------------------------------ right: recommendations + add session */}
        <div className="space-y-4 self-start">
          <div>
            <h2 className="text-lg font-semibold">Recommendations for next session</h2>
            <p className="text-sm text-muted">Suggestions for the counselor to confirm and adapt.</p>
          </div>

          {latest && latest.recommendations.length > 0 ? (
            latest.recommendations.map((r, i) => {
              const context = [...new Set(r.based_on.map(subLabel))].join(" · ");
              return (
                <article key={r.id} className="rounded-xl border border-accent/30 bg-surface p-5">
                  <SmallCaps accent>Focus area</SmallCaps>
                  <h3 className="mt-1 font-semibold">{r.topic}</h3>
                  {context && <p className="mt-1 text-sm text-muted">Based on: {context}.</p>}
                  {i === 0 && latest.changes.length > 0 && (
                    <div className="mt-2 text-sm text-muted">
                      <p className="text-xs font-semibold uppercase tracking-wide">Since earlier sessions</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                        {latest.changes.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-3 space-y-3">
                    <div>
                      <SmallCaps>Conversation starters</SmallCaps>
                      <p className="mt-0.5 text-sm">{r.open_question}</p>
                    </div>
                    <div>
                      <SmallCaps>Suggested approach</SmallCaps>
                      <p className="mt-0.5 text-sm">{r.suggested_approach}</p>
                    </div>
                  </div>
                </article>
              );
            })
          ) : (
            <p className="rounded-xl border border-dashed border-line bg-surface p-5 text-sm text-muted">
              {latest ? "No recommendations for this session." : "Recommendations appear after the first session is analyzed."}
            </p>
          )}
        </div>
      </div>
      </div>

      {/* ------------------------------------------------ session history */}
      <SectionCard title="Session history">
        {sessions.length === 0 ? (
          <p className="text-sm text-muted">No sessions yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="flex items-center gap-3">
                  <span className="font-medium">{formatDate(s.session_date)}</span>
                  <span className="text-muted">{s.source === "audio" ? "Audio" : "Pasted transcript"}</span>
                  <StatusChip status={s.status} />
                </span>
                <Link href={`/sessions/${s.id}`} className="font-medium text-accent-dark hover:underline">
                  Open session
                </Link>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <form action={deleteStudentAction} className="pt-2 text-center">
        <input type="hidden" name="student_id" value={student.id} />
        <ConfirmButton
          message="Delete this student and all of their sessions, transcripts and analyses? This cannot be undone."
          className="text-xs text-muted hover:underline"
        >
          Delete student
        </ConfirmButton>
      </form>
    </div>
  );
}
