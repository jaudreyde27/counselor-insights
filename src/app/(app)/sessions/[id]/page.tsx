import { notFound } from "next/navigation";
import { checkStatusAction, rerunAnalysisAction, swapSpeakersAction } from "@/app/actions";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ConfirmButton } from "@/components/ConfirmButton";
import {
  BackLink,
  Chip,
  Evidence,
  ProcessingBanner,
  SectionCard,
  SmallCaps,
  StatusChip,
  secondaryButton,
} from "@/components/ui";
import { requireCounselor } from "@/lib/auth";
import { getCriteria } from "@/lib/criteria";
import { withCounselor } from "@/lib/db";
import { formatDate, PROCESSING_STATUSES, processingCopy } from "@/lib/data/format";
import { getSessionView } from "@/lib/data/sessions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ swapped?: string }>;
}) {
  const { id } = await params;
  const { swapped } = await searchParams;
  if (!UUID.test(id)) notFound();
  const counselor = await requireCounselor();
  const s = await withCounselor(counselor.id, (c) => getSessionView(c, counselor.id, id));
  if (!s) notFound();

  const criteria = getCriteria();
  const processing = PROCESSING_STATUSES.includes(s.status);
  // A failed recording without a transcript is re-run by transcribing it again; otherwise the analysis is re-run.
  const canRerun = ["transcribed", "complete", "failed"].includes(s.status);
  const canCheckStatus = s.source === "audio" && ["uploaded", "transcribing"].includes(s.status);

  return (
    <div className="space-y-6">
      <BackLink href={`/students/${s.student_id}`}>{s.student_name}</BackLink>

      <SectionCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">Session · {formatDate(s.session_date)}</h1>
            <StatusChip status={s.status} />
            <span className="text-sm text-muted">{s.source === "audio" ? "Audio" : "Pasted transcript"}</span>
          </div>
          <div className="flex gap-2">
            {s.source === "audio" && (
              <form action={checkStatusAction}>
                <input type="hidden" name="session_id" value={s.id} />
                <button className={secondaryButton} disabled={!canCheckStatus} title="Fetch the transcript now, if it has not arrived on its own">
                  Check status
                </button>
              </form>
            )}
            <form action={rerunAnalysisAction}>
              <input type="hidden" name="session_id" value={s.id} />
              <button className={secondaryButton} disabled={!canRerun}>
                Re-run analysis
              </button>
            </form>
          </div>
        </div>
        {s.error_message && <p className="mt-3 text-sm text-muted">{s.error_message}</p>}
        {s.run && (
          <p className="mt-3 text-xs text-muted">
            Analysis run with model {s.run.model_id}, prompt {s.run.prompt_version}, criteria {s.run.criteria_version}.
            {s.run.dropped_quote_count > 0 &&
              ` ${s.run.dropped_quote_count} ${s.run.dropped_quote_count === 1 ? "quote" : "quotes"} could not be matched to the transcript and ${s.run.dropped_quote_count === 1 ? "was" : "were"} removed.`}
          </p>
        )}
      </SectionCard>

      {swapped && (
        <p className="rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-sm">
          Speakers swapped. The themes below were built on the old labels. Press <strong>Re-run analysis</strong> to update them.
        </p>
      )}

      {processing && (
        <>
          <ProcessingBanner title={processingCopy(s.status).title}>{processingCopy(s.status).text}</ProcessingBanner>
          <AutoRefresh />
        </>
      )}

      {s.themes.length > 0 && (
        <SectionCard title="Themes in this session">
          <div className="divide-y divide-line">
            {s.themes.map((t) => (
              <div key={t.id} className="py-5 first:pt-0 last:pb-0">
                <div className="flex flex-wrap gap-1.5">
                  <Chip size="md">{criteria.subDriver(t.sub_driver_id)?.label ?? t.other_label ?? "Other"}</Chip>
                  <Chip size="md">{criteria.domain(t.domain_id)?.label ?? "Other"}</Chip>
                </div>
                <h3 className="mt-3 font-semibold">{t.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed">{t.interpretation}</p>
                <Evidence quotes={t.evidence} sessionId={s.id} date={s.session_date} />
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      <SectionCard>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Transcript</h2>
          <form action={swapSpeakersAction}>
            <input type="hidden" name="session_id" value={s.id} />
            <ConfirmButton
              message="Swap who is the counselor and who is the student on every line of this transcript?"
              className={secondaryButton}
            >
              Swap speakers
            </ConfirmButton>
          </form>
        </div>
        <ol className="space-y-1">
          {s.utterances.map((u) => (
            <li key={u.id} id={`u-${u.idx}`} className="utterance scroll-mt-20 rounded-lg px-3 py-2">
              <SmallCaps accent={u.speaker === "student"}>{u.speaker === "student" ? "Student" : "Counselor"}</SmallCaps>
              <p className="mt-0.5 text-sm">{u.text}</p>
            </li>
          ))}
        </ol>
      </SectionCard>
    </div>
  );
}
