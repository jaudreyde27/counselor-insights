# Work Log

One entry per meaningful change, newest first. Each entry is committed together with the change it describes.

Entry format: timestamp and time zone, author, summary, affected components, verification performed, blockers or handoff notes.

---

## 2026-11-07 AWS setup started: account created, root MFA skipped

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** The AWS account ("Rubber Ducking") was created by the project owner on the **free plan** ($100 credits, about 182 days). The IAM security-credentials page showed "Feature unavailable: activate advanced features", so MFA for the root user could not be set up the usual way. After the risks were explained, the owner **decided to skip root MFA**. Recorded in `docs/AWS_SETUP.md` with the minimum protections (long unique password, no root access keys, budget alert on). Also noted: do not enable IAM Identity Center or AWS Organizations (reported to move an account off the free plan); step 4 will use an IAM admin user.
- **Not confirmed:** whether the free plan blocks RDS or Bedrock; what "activate advanced features" does; whether upgrading keeps the credits.
- **Open question to settle at step 4:** the AWS CLI needs credentials. Without Identity Center that means long-lived access keys for an IAM user on this laptop, which is a risk of its own. AWS CloudShell in the browser avoids keys.

---

## 2026-11-07 Phase 3: deployment code (nothing deployed)

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** (1) Cognito sign-in (`AUTH_MODE=cognito`; authorization code flow with PKCE; ID token verified with aws-jwt-verify; httpOnly session cookie; plain error codes; the login page and sign-out adapt to the mode). (2) `Dockerfile` (three stages, non-root, no `.env`) with a one-off migration runner (`node dist/migrate.cjs`, bundled by esbuild); `DB_SSL=require`; the mock AI is refused in production. (3) AWS CDK in `infra/`: network without a NAT gateway and with an S3 gateway endpoint, RDS Postgres 16 (private, encrypted, single zone, 7-day backups), the private audio bucket (CORS PUT only, no expiry, not auto-emptied), Cognito (admin-created users, public PKCE client, Managed Login), ECR, one Fargate task behind an HTTPS load balancer (DNS-validated certificate, HTTP redirects), a separate migration task, a least-privilege task role (S3 and Bedrock InvokeModel only), 30-day logs, three alarms and CloudTrail, an optional GitHub OIDC deploy role (main branch of one repository only, no stored keys), and a scheduled scale to zero at 2026-12-16T08:00Z. (4) GitHub Actions: `ci.yml` (lint, type check, tests with a throwaway Postgres, build, image build) and `deploy.yml` (push image, run migrations as a one-off task, update the service; does nothing until `AWS_DEPLOY_ROLE_ARN` is set). (5) `scripts/dns-records.sh` (read-only; prints the two Cloudflare records). (6) `docs/AWS_SETUP.md` now has the real deploy order (secrets first; first deploy with `-c desiredCount=0`; create the Cognito user; connect GitHub; start the app), README deploy section, rules in AGENTS.md and CLAUDE.md.
- **Verification:** 18 Cognito tests against a fake provider (a skipped state check makes one fail); the image was built and run as a production container (healthz 200, signed-out visitors redirected, Cognito sign-in started with PKCE, non-root, no `.env`, dev login refused with a 500) and its migration runner applied all 8 migrations to a scratch database and was a no-op the second time; `cdk synth` runs offline and a missing setting stops with a plain list; 32 template tests (a public database, open sign-up and a missing scale-down each make one fail); both workflow files parse and all 13 shell steps pass `bash -n`; `dns-records.sh` and `store-secret.sh` pass `bash -n` and a dry run and contain no write commands outside their stated purpose.
- **NOT verified (needs real services):** Cognito against a real user pool; S3, AssemblyAI and Bedrock calls; the CDK deploy itself (CloudFormation can still reject things the template tests cannot see, such as quotas, name clashes and certificate validation timing); the GitHub workflows actually running (actionlint could not be run; only YAML parsing and shell syntax were checked); the real RDS connection with `DB_SSL=require`.
- **Decisions to review:** the bucket and database are removed by `cdk destroy` only deliberately (the bucket stops the destroy if it still holds recordings); the app has no alarm for "no healthy task" because the planned scale to zero would email forever; `cdk deploy` after the workflow has registered newer task revisions resets the image to the `latest` tag.
- **Nothing was deployed and no AWS account, GitHub repository, AssemblyAI account or key exists.**

---

## 2026-11-07 00:10 PT. The prototype deactivates after December 15, 2026

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** New requirement from the project owner: the tool is only for a class project (due December 2, 2026) and must deactivate after December 15, 2026. Built it in: `src/lib/lifecycle.ts` holds the rule (`APP_ACTIVE_UNTIL`, default 2026-12-15, active through the END of that day in Pacific time, daylight-saving safe, a malformed value fails closed). `src/proxy.ts` (Next.js 16 "proxy") refuses everything after the date: pages and form submissions get a 410 and a plain notice page (no student data, noindex), API calls (uploads, the transcription webhook, local storage) get a JSON 410, and only `/healthz` still answers. Backup guards: nobody is signed in (`getCurrentCounselor`), and `startAnalysis`, `startTranscription` and `finishTranscription` do nothing, so no model or AssemblyAI calls happen. `docs/SHUTDOWN.md` is the teardown checklist; README and `docs/AWS_SETUP.md` point to it. Recorded in `AGENTS.md` and `CLAUDE.md`. `.env.example` and the local `.env` have `APP_ACTIVE_UNTIL=2026-12-15`; the tests pin a far-future date so they never break on the real deadline.
- **Affected components:** `src/lib/lifecycle.ts`, `src/proxy.ts`, `src/lib/auth/index.ts`, `src/lib/analysis/start.ts`, `src/lib/transcription/process.ts`, `tests/lifecycle.test.ts`, `tests/setup-env.ts`, `docs/SHUTDOWN.md`, `.env.example`, `README.md`, `AGENTS.md`, `CLAUDE.md`.
- **Important limit:** switching the app off does NOT stop AWS charges or delete data (the load balancer, database and bucket keep billing and keep their contents). The Phase 3 infrastructure must include a scheduled scale-to-zero of the app server for December 16, and a person must run the teardown in `docs/SHUTDOWN.md`. No automatic data deletion was built (it cannot be undone, so it was not assumed).
- **Spec deviations (override `docs/SPEC.md`, recorded in AGENTS.md and CLAUDE.md):** the end date; the spec has none.
- **Verification:** 18 new tests (the last second of December 15 PST is active and 08:00 UTC on the 16th is off; July/PDT; leap day; malformed values fail closed; default date; the proxy refuses pages, POSTs, uploads, webhook and local storage with 410 and lets only `/healthz` through; the guards stop analysis and transcription). Two deliberate breakages (never switching off, and switching off a day early) each made tests fail. Checked live: with the date set to the past the browser showed the notice and curl got 410 everywhere except `/healthz` (200); the real date was then restored and the app worked again.
- **Blockers / handoff:** Decide the teardown date (and who runs it) before Phase 3. Each extra day running costs roughly $2.

---

## 2026-11-06 23:30 PT. AWS budget changed to $25

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** The monthly AWS budget in `docs/AWS_SETUP.md` step 3 is now **$25** (alerts at 50%, 80% and 100%, so $12.50, $20 and $25) instead of the $75 suggested in SPEC.md section 14. Added a note that a budget only warns, and that $25 is below the roughly $50 to $60 a month estimated to keep the deployed app running, so alerts should be expected once it is deployed and left on. Recorded in `AGENTS.md` and `CLAUDE.md`.
- **Affected components:** `docs/AWS_SETUP.md`, `AGENTS.md`, `CLAUDE.md`. No code changed. No AWS account exists yet, so nothing was created.
- **Verification:** documentation only; checked that no other file mentions the old figure.
- **Blockers / handoff:** When the budget is created in AWS Budgets (step 3), use $25. Decide before Phase 3 whether the stack is left running or torn down between uses.

---

## 2026-11-06 23:00 PT. Phase 2: audio (built with local stand-ins)

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** Audio upload and transcription, as in SPEC.md section 5 steps 1 to 4. (1) Upload: the browser calls `prepareAudioUploadAction` (checks the consent tick, saves `consent_confirmed_at`, creates the student if new, creates the session as `awaiting_upload`, returns a 15-minute presigned PUT link), sends the file straight to storage with a progress bar, then `POST /api/sessions/{id}/upload-complete` checks the object exists (HeadObject) and starts the transcription. Accepts mp3, m4a (audio/mp4, audio/x-m4a) and wav; the key is `audio/{session id}.{ext}`. (2) Storage: `src/lib/storage/` with a local folder implementation using real signed, expiring links (dev only) and an S3 implementation (presigned PUT/GET, HeadObject, Delete). (3) Transcription: `src/lib/transcription/` with an AssemblyAI client (written to the current API docs: submit with `audio_url`, `speaker_labels`, `speakers_expected: 2`, `language_code: "en"`, `webhook_url`, `webhook_auth_header_name/value`; GET and DELETE `/v2/transcript/{id}`) and a local mock that picks a fictional transcript and calls the real webhook. (4) Webhook `POST /api/webhooks/assemblyai`: rejects a missing or wrong secret header with 401 (constant-time compare; 500 if no secret is configured), answers 200 at once and does the work after, finds the session through a narrow SECURITY DEFINER database function (migration 0008). (5) Speaker mapping: first speaker = counselor, other = student, `student_speaker_label` saved; Swap speakers now also swaps that label. (6) **Check status** and **Re-run analysis** on the session page; re-running a failed recording with no transcript transcribes it again. (7) Status banners say Uploading / Transcribing / Analyzing. (8) Stale sessions are closed out when a page loads (an upload waiting 30 minutes; an analysis with no sign of life for 15 minutes), which fixes the Phase 1 gap where a restart left a session on "Analyzing". (9) The provider's copy of a transcript is deleted after saving (best effort). (10) `docs/AWS_SETUP.md` and `scripts/store-secret.sh` (stores the AssemblyAI key in Secrets Manager without it appearing anywhere; dry-run only so far). (11) Silent placeholder WAVs in `fixtures/audio/` for trying the upload (`npm run fixtures:audio`).
- **Affected components:** `src/lib/storage/`, `src/lib/transcription/`, `src/app/api/`, `src/app/actions.ts`, `src/components/forms.tsx`, `src/lib/data/{sessions,students,maintenance,format,audit}.ts`, session and student pages, `migrations/0008_webhook_lookup.sql`, `scripts/`, `fixtures/audio/`, `docs/AWS_SETUP.md`, `.env.example`, `tests/`.
- **Decisions to review:** (a) Deleting a student also deletes their recordings from storage (SPEC says audio is deleted by hand; deleting a student is a deliberate delete, and leaving a recording behind seemed worse for privacy). (b) With only one speaker detected, every line is treated as the student's. (c) A recording that fails to upload or transcribe is re-run with the existing "Re-run analysis" button rather than a new button. (d) The webhook answers 200 for an unknown transcript id so the sender stops retrying.
- **Spec notes:** the spec says "Check status" is on the session page (done). The webhook secret header is `x-webhook-secret`. No names are stored anywhere in keys or logs.
- **Verification:** all tests pass (167 tests, 13 files). New tests cover: accepted recording types and key naming, signed links (15-minute and 1-hour expiry, tampering, wrong method, wrong content type, bad keys), local storage, the production safety rules for both stand-ins, speaker mapping, the AssemblyAI request shapes with a fake fetch, the mock transcriber, the webhook (missing, wrong, near-miss and empty secrets all rejected; unconfigured never accepted; bad body; unknown id; reply-then-work; safe to call twice), the full chain with a mocked AssemblyAI and mocked Bedrock, Check status (pending, saved, provider error, outage, empty speech), swap speakers on a recording, stale-session cleanup, and that logs hold no transcript text, names or secrets. With the secret check deliberately disabled, 3 webhook tests fail. In the browser: uploaded a WAV with consent, watched it go through to analysis, checked the banners, the failed state and delete-removes-recording.
- **Known gaps / handoff:** S3 and AssemblyAI are written but untested against the real services; the AssemblyAI webhook can only be tested on a public address after the deploy. The mock transcriber does not listen to audio. Troy/Krsna: transcription quality on accented English is still untested until the team's recordings are run.

---

## 2026-11-06 21:10 PT. Phase 1 revisions, round 6: severity follows the student's language

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** The "most important themes only" judgment now leans on the severity of the student's own language and sentiment. New `prompts/v3/call1_themes.md`: strong, emotionally charged or absolute wording (for example "terrified", "never", "nobody"), described effects on sleep, eating, health or daily functioning ("I can't sleep", "I skip meals"), repetition and emphasis point to a major theme; mild or casual wording ("it's a bit annoying") points to a minor one; share of the conversation and life impact count too, but the language leads. It also warns about understatement (a student downplaying something heavy: treat it as major and say so as an interpretation). Call 2 (`prompts/v3/call2_recommendations.md`) favors themes with the most intense supporting quotes when choosing its two recommendations. `PROMPT_VERSION` defaults to `v3` (also in `.env.example` and the local `.env`). v1 and v2 are unchanged.
- **Affected components:** `prompts/v3/`, `src/lib/analysis/prompts.ts`, `.env.example`, `tests/`, `AGENTS.md`, `CLAUDE.md`, `README.md`.
- **Decision to review:** The AI still does NOT output a severity label or score, only uses language severity to decide what to include. The spec says "Do not give a severity" and the code has no severity field. If a visible severity (for example a small Major/Notable marker per theme) is wanted, that is a separate change.
- **Important limit:** This is an instruction to the model. How well Claude follows it can only be judged once real runs are possible after the AWS setup. The mock results are hand-written and illustrative; they do not analyse wording.
- **Spec deviations (override `docs/SPEC.md`, recorded in AGENTS.md and CLAUDE.md):** language and sentiment inform which themes are included (SPEC 6.2); prompt version v3.
- **Verification:** 117 tests pass (adds: v3 is the default; v3 carries the language-severity, understatement and no-label wording; call 2 favors intense language; v1 and v2 are unchanged; saved runs record v3). Reseeded the demo data under v3.
- **Known gaps / handoff:** Troy: please read the new wording in `prompts/v3/call1_themes.md` (the example phrases for strong and mild language are mine; edit them to match what you see in real sessions). Krsna: evals should compare v1, v2 and v3 runs.

---

## 2026-11-06 20:45 PT. Phase 1 revisions, round 5: most important themes only

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** (1) New taxonomy rule "Buckets" in `config/criteria.json` (passed to call 1 word for word): it is fine for a student to have nothing in some of the three domains; themes can be in only one bucket or any mix; never add a theme just to fill one. The taxonomy version is now 1.1. (2) New analysis instructions in `prompts/v2/call1_themes.md`: report only the most important sources of distress (major ones; leave out minor or passing mentions; for example, if money worries are major and a roommate disagreement is minor, report only the money worries), prefer a short list, never give a severity or score. v1 is kept unchanged. `PROMPT_VERSION` now defaults to `v2` (also set in `.env.example`, and in the local `.env`, which had pinned `1`). (3) The hand-written mock results now list only the major themes (the roommate transcript shows 3 themes in 2 buckets), and the keyword fallback shows at most 4.
- **Affected components:** `prompts/v2/`, `config/criteria.json`, `src/lib/analysis/prompts.ts`, `src/lib/llm/mock.ts`, `fixtures/mock/*`, `.env.example`, `tests/`, `AGENTS.md`, `CLAUDE.md`, `README.md`.
- **Important limit:** "most important only" is an instruction to the model. The code does not rank or cut themes (there is no severity score, as the spec requires), so how well Claude follows it can only be judged once real model runs are possible (after AWS setup). The mock results are hand-written to show the intended outcome.
- **Spec deviations (override `docs/SPEC.md`, recorded in AGENTS.md and CLAUDE.md):** the "major themes only" instruction (SPEC 6.2); the Buckets rule (SPEC Appendix A); criteria version 1.1 and prompt version v2.
- **Verification:** 115 tests pass (adds: the buckets rule is in the config and the prompt; the prompt carries the importance instruction and the no-scoring line; themes in only one bucket are accepted; v2 is the default and v1 is unchanged; fixtures show themes in two or fewer buckets; saved runs record prompt v2 and criteria 1.1). Reseeded the demo data under v2.
- **Known gaps / handoff:** Troy: please read the new "Buckets" rule and the importance wording in `prompts/v2/call1_themes.md`. Krsna: evals should compare v1 and v2 runs.

---

## 2026-11-06 20:10 PT. Phase 1 revisions, round 4

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** (1) New Student: the first session is now optional, so a student (with key notes) can be created without uploading anything; sessions are added later from their page. (2) Sub-driver bubbles are slightly larger (`Chip` has a `md` size). (3) "Distress profile" is now "Student profile". (4) The student list can be filtered by session count (No sessions, 1, 2, 3 or more); the column sizes were tuned so seven columns and the new funnel fit a roughly 650px pane. (5) The "Use fake data only" call-out is removed from the footer and page description; the footer says "Prototype".
- **Security fix found while testing:** if a form was submitted before the page's JavaScript finished loading, the browser's default (GET) put the student's name, notes and other fields in the web address. Both upload forms now use POST (multipart), so the data stays in the request body.
- **Affected components:** `src/components/forms.tsx`, `src/components/ui.tsx`, `src/components/AppShell.tsx`, `src/app/layout.tsx`, `src/app/actions.ts`, student list and student pages, `src/lib/data/students.ts`, `src/lib/student-options.ts`, `tests/data.test.ts`, `AGENTS.md`, `CLAUDE.md`.
- **Spec deviations (override `docs/SPEC.md`, recorded in AGENTS.md and CLAUDE.md):** optional first session (SPEC 7.5 page 3); "Student profile" (SPEC 7.5); no fake-data footer (SPEC 7.3).
- **Verification:** all tests pass (adds session-count filter cases, including unknown values matching nothing). Checked in the browser: Sessions filter, tuned list at 653px, larger bubbles, renamed heading, "Prototype" footer, creating a student with no upload shows the key notes, and the POST form.
- **Known gaps / handoff:** unchanged: audio shows a "not connected yet" message until Phase 2.

---

## 2026-11-06 19:30 PT. Phase 1 revisions, round 3

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** (1) Student list column titles were not lined up with their columns: the header and each row were separate grids that sized themselves by their content. All use the same fixed column widths now (`minmax(0, …)`) and each title is centered over its column, values centered too. (2) Spacing pass on the student and session pages: more room around themes, evidence and cards; the "Evidence" line no longer sits against the divider. (3) Removed the "New" / "Recurring" tags and the code behind them (`recurrence.ts`, its query and tests). (4) Removed the taglines next to the three bucket names on the student page ("How it feels", "They don't know how", "They know how, but something outside blocks them"). The taglines stay in `config/criteria.json` and still appear in the analysis prompt.
- **Affected components:** student list page, student page, session page, `src/components/ui.tsx`, `src/lib/data/students.ts`, `tests/`, `AGENTS.md`, `CLAUDE.md`.
- **Spec deviations (override `docs/SPEC.md`, recorded in AGENTS.md and CLAUDE.md):** no New/Recurring chips (SPEC 7.2, 7.5); no bucket taglines (SPEC 7.5).
- **Verification:** 110 tests pass (the New/Recurring tests were removed with the feature). Checked by hand in the browser: centered, aligned list headers; theme cards with no tags, plain bucket labels and open space above dividers.
- **Known gaps / handoff:** The "changes since earlier sessions" note on the first recommendation is unchanged.

---

## 2026-11-06 19:00 PT. Phase 1 revisions, round 2

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** (1) Fields now spread across the page: the cause of the "clustered on the left" look was that the preview pane is about 736px wide, just under the 768px window breakpoint the layouts used, so it showed the stacked phone layout. The list, the student summary, the two-column area and the New Student form now respond to the width of their own container (Tailwind container queries), and the page fills the window (max 1536px) instead of a 1152px column. (2) Every school now starts with "Stanford" (Stanford Graduate School of Business, Stanford School of Engineering, Stanford School of Medicine, Stanford School of Law, Stanford Undergraduate); migration 0007 renames existing students. (3) Session notes removed: the form field, the session page card, the `sessions.notes` column (migration 0007) and the tests. (4) The Add a session call to action is a slim single row (title, Audio/Transcript switch, file, date, consent, button): about 40px tall at wide sizes versus about 235px before. (5) The seed students have a few key notes (for example "Wants to become a software engineer after graduating") instead of "Fictional demo student"; the student notes field is labelled "Key notes" with an example placeholder.
- **Affected components:** `migrations/0007`, `src/lib/student-options.ts`, `src/components/forms.tsx`, `src/components/AppShell.tsx`, student list, new-student, student and session pages, `src/app/actions.ts`, `src/lib/data/sessions.ts`, `scripts/seed.ts`, `AGENTS.md`, `CLAUDE.md`, `tests/`.
- **Spec deviations (override `docs/SPEC.md`, recorded in AGENTS.md and CLAUDE.md):** no session notes; school names start with "Stanford"; the page container is no longer capped at max-w-6xl.
- **Verification:** all tests pass (adds: school list, only listed schools accepted, sessions have no notes column, students keep key notes, no crisis table or column). Checked by hand in the browser at the pane's real width (736px), 1440px and 375px: list, student page, new student form, no sideways scrolling.
- **Known gaps / handoff:** unchanged: audio shows a "not connected yet" message until Phase 2.

---

## 2026-11-06 18:10 PT. Phase 1 revisions after owner review

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** (1) Removed everything to do with crisis language: the call 1 crisis check and output field, crisis quote verification, the `crisis_evidence` table and `analysis_runs.crisis_flag` (migration 0005), the banner and list marker, the "safety flag" classification rule in `config/criteria.json`, the crisis fixture (replaced by a housing and roommate fixture, `03-housing-conflict`), mock keywords and tests. (2) Students now have a degree type (Bachelors or Masters) and a program of study instead of a graduation year (migration 0006); School is a dropdown of Stanford Graduate School of Business, School of Engineering, School of Medicine, School of Law and Undergraduate. The student list filters by school and degree, no longer by country. (3) Adding a student or a session is now a file upload: audio recording is first and the default, with a transcript file (.txt or .json) as the alternative. The paste box and the sample-transcript picker are gone. (4) "Add a session" is a call to action at the very top of the student page. (5) Fields run left to right in the forms, the student summary and the list.
- **Affected components:** `migrations/0005`, `0006`, `src/lib/analysis/*`, `src/lib/llm/*`, `src/lib/data/*`, `src/lib/transcript.ts`, `src/lib/student-options.ts`, `src/app/actions.ts`, `src/components/forms.tsx`, student list, new-student and student pages, `fixtures/`, `scripts/seed.ts`, `AGENTS.md`, `CLAUDE.md`, `tests/`.
- **Spec deviations (these override `docs/SPEC.md`, now recorded in AGENTS.md and CLAUDE.md):** all of the above. `docs/SPEC.md` itself was NOT edited and still describes crisis handling and graduation year.
- **Verification:** all tests pass (added: degree filter, the database rejects other degree types, transcript file reading for .txt and .json, the ready-made upload files match the fixtures). Checked by hand in the browser: list with degree filter, student page with the call to action at the top, audio attempt (explains transcription is not connected and sends nothing), transcript-file upload to an existing student and for a new student, phone width with no sideways scrolling.
- **Known gaps / handoff:** Choosing an audio recording shows a message that transcription is not connected yet and creates nothing; audio upload, S3 and AssemblyAI are Phase 2. Existing local data was reseeded.

## 2026-11-06 17:15 PT. Phase 1, checkpoint 4: screens and dev login (Phase 1 complete)

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** Built the screens from SPEC.md section 7 for pasted transcripts: sign-in, student list (funnel filters on School and Country, sort on Last session, ⚠ crisis marker, empty state), New Student, the one-page student view (crisis banner, summary card, processing banner that polls, Distress profile with domain cards and New/Recurring chips, collapsed Evidence, Recommendations with Add a session, session history, Delete student) and the session page (status, Re-run analysis, transcript with Swap speakers, themes, notes, quote links that jump to and highlight the line). Server actions re-check the signed-in counselor and run analysis in the background. `src/lib/auth` holds the dev-only login bypass (fake counselors; `AUTH_MODE=dev`; it throws if enabled in a production build). Audit events are written for create, view, re-run, swap and delete. `npm run db:seed` adds fictional demo students. The optional edit mode (7.7) was not built.
- **Affected components:** `src/app/`, `src/components/`, `src/lib/auth/`, `src/lib/data/`, `src/lib/analysis/start.ts`, `src/lib/samples.ts`, `scripts/seed.ts`, `migrations/0004_positions.sql`, `next.config.ts`, `tests/`.
- **Spec deviations (please review):** (1) `themes.position` and `recommendations.position` added in migration 0004 so results keep the order the analysis produced (recommendations are "most important first"). (2) The "changes since earlier sessions" notes are shown as a short list on the first recommendation card, not in the context line. (3) New Student and Add a session are paste-only (audio arrives in Phase 2), so there is no consent checkbox yet; session notes can be added on Add a session. (4) `npm run build` sets `AUTH_MODE=off` because a production build refuses the dev login. (5) `next.config.ts` traces `config/`, `prompts/` and `fixtures/` into the standalone output so the Docker image has them.
- **Verification:** 106 tests pass (adds: dev-login safety, student list filters/sort/crisis marker, student-page data incl. New/Recurring and ordering, swap speakers flips and restores labels, delete cascades and keeps audit rows without names, another counselor cannot view/swap/delete). Checked by hand in the browser at desktop and phone width: sign-in, list, student page with crisis banner, add a session from a sample, re-run (keeps the earlier run), session page with quote-to-line jump, form error keeps typed text, empty state for the second counselor, 404 for another counselor's student, processing banner. No horizontal scrolling at 375px. `npm run lint`, `typecheck` and `build` pass.
- **Known gaps / handoff:** The processing banner is wired to polling but with the mock AI it is only visible for an instant (checked by setting a session's status by hand). If the server restarts mid-analysis the session stays "Analyzing" until Re-run is pressed (SPEC section 5 says it should show failed). Audio, AssemblyAI webhook tests and the AWS-dependent tests are Phase 2 and 3. Real Claude behavior is untested until AWS.

## 2026-11-06 16:45 PT. Phase 1, checkpoint 3: analysis pipeline

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** Added the analysis pipeline. Call 1 (themes + crisis check) and call 2 (recommendations) go through one `LlmClient` interface with a mock implementation (`LLM_MODE=mock`) and a Bedrock Converse implementation (written, **not yet run against AWS**). Prompts are files in `prompts/v1/`. Quote verification, taxonomy-id checks, the two-recommendation cap and an immigration-status wording guard run in code. `runAnalysisForSession` saves each run separately (re-runs keep earlier runs) and records model id, prompt version and criteria version. `npm run analyze -- <file> [--json]` runs the pipeline on a transcript file with no database. Added the pasted-transcript parser, `src/lib/log.ts` (only ids, numbers and booleans; text is redacted) and five fictional fixtures with hand-written mock results: homesickness/career, visa fear across three domains, crisis language, a theme outside the taxonomy, and a stated immigration status.
- **Affected components:** `src/lib/analysis/`, `src/lib/llm/`, `src/lib/transcript.ts`, `src/lib/log.ts`, `prompts/`, `fixtures/`, `scripts/analyze.ts`, `migrations/0003_run_changes.sql`, `tests/`.
- **Spec deviations (please review):** (1) `analysis_runs.changes_since_earlier_sessions text[]` added in migration 0003 so the "changes since earlier sessions" note survives a page reload (SPEC 6.4 and 7.5 show it but section 4 has no column). (2) The status-wording guard (`status-guard.ts`) is an extra safety net for the "never state immigration status" rule; it drops any theme or recommendation whose own wording names a status such as F-1, OPT or green card. Quotes are not checked by it. (3) Themes tagged "other" store `domain_id = 'other'`. (4) Quote matching ignores apostrophes entirely so "it's", "its" and "it’s" match.
- **Verification:** 90 tests pass (quote verifier, parser, all five fixtures through the pipeline, scripted-model failure cases, retry-once, database pipeline with re-run and earlier-session handling, the payload sent to the model contains no student record or notes, logs contain no names, quotes or notes). `npm run lint`, `typecheck` pass. `npm run analyze` checked by hand on the crisis and status fixtures.
- **Blockers / handoff:** The mock AI proves the plumbing, not the prompt quality; real model behavior is untested until AWS (Phase 3 setup). Troy/Krsna: `npm run analyze -- <file> --json` is the entry point for evals.

## 2026-11-06 16:35 PT. Phase 1, checkpoint 2: database, RLS and criteria config

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** Added SQL migrations for all ten tables from SPEC.md section 4 (`migrations/0001_init.sql`) and row-level security policies (`0002_rls.sql`). A small migration runner (`npm run db:migrate`) applies them in order. The app connects as the non-superuser `app_user`; `withCounselor()` in `src/lib/db.ts` sets `app.current_counselor_id` per transaction. `find_or_create_counselor()` is a narrow SECURITY DEFINER function so first sign-in can create the counselor row. Seeded `config/criteria.json` from Appendix A (30 sub-drivers, 7 rules) with a validating loader (`src/lib/criteria.ts`) that accepts extra fields. Sub-driver ids are snake_case of the label with "and" dropped, matching the spec's `homesickness_grief` example.
- **Affected components:** `migrations/`, `config/`, `src/lib/{db,db-config,migrate,criteria}.ts`, `scripts/migrate.ts`, `tests/`.
- **Verification:** 30 tests pass: criteria loader (seeded, edited list, extra fields, bad input) and RLS across two counselors on all 10 tables (reads, updates, deletes, cross-owner inserts, no-counselor-set, no leakage on a reused connection). With RLS deliberately disabled on two tables the RLS tests fail (9 failures), then pass again once restored. A clean database rebuild from scratch applies both migrations.
- **Blockers / handoff:** Policies are not "FORCE"d on the table owner so the sign-in function keeps working on RDS later; the app role is the restricted one. Troy: please check the ids and wording in `config/criteria.json` against the taxonomy.

## 2026-11-06 16:25 PT. Phase 0: project setup

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** Added the Next.js 16 (TypeScript) and Tailwind CSS 4 scaffold with the design tokens from SPEC.md 7.2, ESLint, Vitest, a `/healthz` endpoint, a Docker Compose Postgres 16 for local development, `.env.example`, `README.md`, this log, `AGENTS.md` and `CLAUDE.md`.
- **Affected components:** project root config, `src/app`, `tests`, `docker-compose.yml`.
- **Verification:** `npm run lint`, `npm run typecheck`, `npm test` (2 tests) and `npm run build` pass. Local Postgres starts healthy and accepts a login. The dev server serves the placeholder page and `/healthz` returns 200.
- **Blockers / handoff:** No AWS, no accounts, no real keys. Local database credentials live only in the git-ignored `.env`. Phase 1 has not started.

## 2026-11-06 16:04 PT. Initial commit

- **Author:** Audrey DeGuerrera (built with Claude Code)
- **Summary:** Created the Git repository with `docs/SPEC.md` and `.gitignore`.
- **Affected components:** repository root, `docs/`.
- **Verification:** Commit `841dac2` contains exactly those two files. No remote is configured.
- **Blockers / handoff:** None.

## 2026-11-07 — Claude (with project owner) — AWS step 4 done: signed in; region changed to us-east-2
- AWS told us the project "Rubber Ducking" is fixed to **us-east-2**, and `aws login` refuses other regions. Production defaults moved from us-west-2 to us-east-2 (infra config, scripts, deploy workflow, Bedrock/S3 clients, .env.example, AWS_SETUP.md). Cognito test fixtures left as arbitrary strings.
- `aws login --region us-east-2` worked (root, temporary credentials). Account ID is <account-id> (the earlier <account-id> was a misread/other screenshot).
- Verified: `aws sts get-caller-identity` returns the account; 237 tests, typecheck pass. Not verified: CDK accepting `aws login` credentials; Claude on Bedrock being available in us-east-2 on the free plan (step 6).
- Handoff: step 6 (Bedrock model access), then secrets, `cdk bootstrap`, first deploy.

## 2026-11-07 — Claude (with project owner) — AWS step 6: Bedrock model chosen
- Tested real `converse` calls in us-east-2 (tiny fictional prompt, no student data). Works: `us.anthropic.claude-sonnet-4-6`, `us.anthropic.claude-opus-4-6-v1`, `us.anthropic.claude-haiku-4-5-20251001-v1:0`. Blocked on this free-plan account ("not available for this account"): the 5.x models (sonnet-5-5, haiku-5-5, sonnet-5, fable-5), and sonnet-4-5. An earlier "account is being verified" message cleared.
- Decision: deploy with `-c bedrockModelId=us.anthropic.claude-sonnet-4-6` (US-only profile, never "global").
- Not verified: real analysis quality/JSON validity on this model (only the mock has run); prompt/response logging in Bedrock must stay off.

## 2026-11-07 — Claude (with project owner) — Switched to the school AWS account
- Project owner restarted AWS setup on a new account made with the school email (project "Console Dot Dream", account <account-id>, us-east-2, free plan). The earlier business account (<account-id>) was only used for sign-in and a few tiny fictional Bedrock tests; nothing was deployed there and nothing in the repo refers to it.
- `aws login --region us-east-2` works as root on the new account (the old login link in `~/.aws/config` was cleared; backup kept outside the repo).
- Bedrock re-tested on the new account: `us.anthropic.claude-sonnet-4-6` and Haiku 4.5 work; Sonnet 5.5 is blocked. Deploy model stays `us.anthropic.claude-sonnet-4-6`.
- Still to do: $25 budget on the new account (excluding Credit and Refund), AssemblyAI key, GitHub repo, secrets, `cdk bootstrap`, first deploy.

## 2026-11-07 — Claude (with project owner) — First deploy to the school AWS account; GitHub deploy blocked
- Infrastructure deployed (`CREATE_COMPLETE`) in us-east-2 at studentcounseling.persimmon-care.com, app off (`desiredCount=0`). First attempt failed on the free plan's 1-day RDS backup limit; fixed in `infra/lib/database.ts` and its test. Certificate validated with one Cloudflare CNAME; second CNAME points the hostname at the load balancer. Alert-email subscription confirmed; first user created in Cognito (temporary password sent by email).
- Adding the GitHub deploy role (`-c githubRepo=...`) FAILED: an account-level policy denies `iam:CreateOpenIDConnectProvider` on this free-plan account. Rolled back cleanly. GitHub cannot deploy here; added `scripts/deploy-local.sh` (build, push, migrate, start) as the replacement. Not run yet: the image push from this computer timed out on a ~1.2 Mbit/s upload; to be retried on a faster network.
- Claude on Bedrock now fails with "Model use case details have not been submitted": Anthropic's use case form must be submitted in the Bedrock console (owner action). The first real analysis test is blocked until then.
- The repository was published as a single clean commit (no account IDs, no school email) to github.com/jaudreyde27/counselor-insights.
- Not verified: the app image running on AWS; real Cognito sign-in; Bedrock analysis; AssemblyAI webhook.

## 2026-11-07 — Claude (with project owner) — First real Claude analysis check (Bedrock, Sonnet 4.6)
- After the Anthropic use case form was submitted, Bedrock calls work. Ran `npm run analyze` (LLM_MODE=real, us.anthropic.claude-sonnet-4-6, us-east-2) on two fictional fixtures: 02-visa-fear and 05-status-stated. Both: 4 themes, 2 recommendations, 0 quotes failed verification, nothing dropped. Immigration status was not stated or inferred in the 05 output. Themes sit in sensible buckets and wording tracks the student's language.
- Observations to review by a person (not bugs): in 02 the same quote supports two themes (line 8) and one theme title uses "visa status" (the student's own words); in 05 the sleep line appears under two themes. Only 2 of 5 fixtures run so far; 01, 03 and 04 not yet run for real.
- Not committed to the public repo yet.

## 2026-11-07 — Claude (with project owner) — App running on AWS
- `scripts/deploy-local.sh` built, pushed and migrated fine on a fast network (upload about 5.6 MB/s). The app task then failed to start: ECS could not read the webhook secret. Causes found in CloudTrail: (1) CDK's grant for an imported secret only matched "name-XXXXXX", while ECS asks by plain name, so added an exact-name statement in `infra/lib/app.ts`; (2) the webhook secret was named `...-secret`, and AWS mistakes a trailing hyphen plus exactly 6 characters for its own random suffix. Renamed it to `counselor-insights/assemblyai-webhook-token` (new random value stored by `scripts/store-secret.sh`; old secret scheduled for deletion with a 7-day recovery window). Added a test for the exact-name grant (33 infra tests pass).
- Result: one app task running; `/healthz` and `/login` return 200 at https://studentcounseling.persimmon-care.com (checked from this computer).
- Not verified: Cognito sign-in with the emailed temporary password, creating a student, a real upload (transcript and audio), AssemblyAI webhook, and real Bedrock analysis inside the deployed app.

## 2026-11-07 — Claude (with project owner) — Delete fix, add-user script
- Live-site check: sign-in, transcript upload (about 15 s, real Claude) and audio upload (AssemblyAI webhook saved 10 utterances, analysis ran) all work.
- "Delete student" did nothing: the button relied on the browser's confirm() box, which some browsers silently block. `src/components/ConfirmButton.tsx` now asks inside the page ("Yes, delete student" / "Cancel"); also used by "Swap speakers". Checked in a real browser locally (confirm, delete, redirect). Not yet checked on the live site: deleting a student also deletes their recording in S3.
- Added `scripts/add-user.sh email ["Name"]`: creates a Cognito profile; AWS emails a temporary password. No self sign-up by design (project owner will send emails).

## 2026-11-07 — Claude (with project owner) — Delete and Swap buttons now use plain requests
- Even after the in-page confirmation, "Delete student" still did nothing on the live site, and each click logged a Next.js error ("Server Reference ID did not match the expected format. Received 'y'"). It worked in dev and in a local production build, so the cause is specific to the deployed form-action path and was not found. Replaced the form actions for Delete and Swap speakers with `DELETE /api/students/{id}` and `POST /api/sessions/{id}/swap` (plain fetch from `src/components/ConfirmButton.tsx`, same pattern as the upload-complete route that works live). Removed the old `deleteStudentAction` and `swapSpeakersAction`. Same-site check added (`src/lib/remove-student.ts`, tested).
- Verified locally in a real browser: confirm, DELETE returns 200, student gone; swap returns 200 and shows the "Speakers swapped" note. 239 tests pass. Not yet verified on the live site.

## 2026-11-07 — Claude (with project owner) — README brought up to date for teammates
- README status, "Try the live prototype" (how to get a profile, add a session, fictional-data rule, feedback), Deploying (only the project owner deploys, via `scripts/deploy-local.sh`; GitHub cannot deploy to this free-plan account) and the audio/AI notes now match what actually runs. Verified: deleting a student empties their recording from the audio bucket.
