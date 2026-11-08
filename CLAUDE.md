# Instructions for Claude Code

These rules are the same as in [`AGENTS.md`](AGENTS.md). Both point to the same work log: [`WORK_LOG.md`](WORK_LOG.md).

## Before you change anything

1. Read the most recent entries in `WORK_LOG.md`.
2. Read the relevant part of [`docs/SPEC.md`](docs/SPEC.md).
3. Preserve teammates' work. Do not overwrite, revert or reformat files you were not asked to change.

## After a meaningful change

Add an entry to `WORK_LOG.md` (timestamp with time zone, author, summary, affected components, verification performed, blockers or handoff notes) and commit it together with the change.

## Hard rules

- **All data is fictional.** Never ask for, accept or write real student data.
- **Only themes that came up.** No "not present" results for taxonomy domains.
- **Every theme cites a verified quote.** A theme with no verified quote is dropped.
- **No student details to the model.** Name, school, degree type, program of study, country and the student's key notes are never sent to Claude. Only transcript text (and earlier verified themes for call 2).
- **No student details in logs.** Log IDs and event names only. Never transcripts, quotes, names, schools, countries or notes.
- **No secrets** in code, docs, issues or chat. Use environment variables locally and AWS Secrets Manager when deployed. Never commit `.env`.
- **Never state or infer a student's immigration status** in any output.
- Prompts live in `prompts/` as files, never inline in code. The taxonomy lives in `config/criteria.json`, and editing it must not need a code change.

## Decisions that override `docs/SPEC.md`

The project owner changed these after the spec was written. Follow this list where it differs from the spec.

- **No crisis-language feature.** The tool does not flag, quote, banner or mark crisis language anywhere (no crisis check in call 1, no `crisis_evidence` table, no `crisis_flag`, no crisis banner or list marker). This replaces SPEC.md 6.6 and the crisis parts of 6.2, 6.3, 7.4 and 7.5.
- **Student fields:** school (one of Stanford Graduate School of Business, Stanford School of Engineering, Stanford School of Medicine, Stanford School of Law, Stanford Undergraduate), degree type (Bachelors or Masters), program of study, country of origin, and a few key notes about the student (for example what they want to do after graduating). There is no graduation year and no session notes. The student list filters by school and degree type, not by country.
- **Adding sessions is a file upload, never a paste box.** Audio recording is the primary option and a transcript file (.txt or .json) is the alternative. Fields are laid out left to right across the full width. "Add a session" sits at the very top of a student's page as one slim row, kept small.
- **A student can be created without uploading anything.** The first session is optional, so key notes can be entered and shown from the start. The left section of the student page is called "Student profile". The list can be filtered by session count. The footer says only "Prototype" (no "use fake data only" call-out in the app).
- **Audio (Phase 2).** A recording is uploaded straight to storage with a short-lived link, never through the server. Storage keys are `audio/{session id}.{ext}` and contain no names; only the file's extension and type are ever sent to the server, never its name. The consent tick is required for audio and saved with a timestamp. The webhook must reject any call without the secret header. `STORAGE_MODE=local` and `TRANSCRIPTION_MODE=mock` are development stand-ins and must stay impossible in a production build. Deleting a student deletes their recordings. Never put the AssemblyAI key or the webhook secret in a file or in chat; deployed, they live in AWS Secrets Manager (`scripts/store-secret.sh`).
- **The prototype deactivates after December 15, 2026** (class project, due December 2, 2026). `APP_ACTIVE_UNTIL` (default 2026-12-15, through the END of that day in Pacific time; a malformed value switches the app OFF) is enforced in `src/proxy.ts` (every request except `/healthz` gets 410), `src/lib/auth` (nobody is signed in) and the background jobs. Never remove or weaken that check. It does not stop AWS charges or delete data: `docs/SHUTDOWN.md` is the teardown checklist, and the Phase 3 infrastructure must include a scheduled scale-to-zero of the app for December 16.
- **Deployment (Phase 3).** `AUTH_MODE=cognito` is the only sign-in in production. `LLM_MODE=mock`, `STORAGE_MODE=local`, `TRANSCRIPTION_MODE=mock` and `AUTH_MODE=dev` are all refused in a production build; keep it that way. The infrastructure in `infra/` and the workflows in `.github/` have never been run against AWS or GitHub: say so when describing them. Never store AWS keys in the repository, in docs, in chat or in logs. ONE exception, decided by the project owner on 2026-11-08: the school AWS account is on the free plan, which blocks the GitHub OIDC connection, so the deploy workflow signs in with the access key of a deploy-only AWS user (`counselor-insights-github-deployer`: push the image, run the migration, update the service, nothing else). That key lives only in the encrypted secrets of the GitHub `production` environment (limited to the `main` branch), is created and stored by command (`aws iam create-access-key` piped into `gh secret set`, never displayed), and is deleted with the user at the end of the project (`docs/SHUTDOWN.md`). Do not add other long-lived keys or widen that user's permissions. The deploy workflow never creates or deletes infrastructure.
- **AWS budget is $25 a month** (alerts at 50%, 80% and 100%), not the $75 suggested in `docs/SPEC.md` section 14. See `docs/AWS_SETUP.md` step 3.
- **Forms must never put data in the web address.** Upload forms use POST.
- **Most important themes only, and not every bucket needs one.** The analysis reports only the major sources of distress, judged mainly by the severity of the student's own language and sentiment (strong, charged or absolute wording and described effects on sleep, eating or daily life point to a major theme; mild or passing wording to a minor one; watch for understatement) (a minor or passing mention is left out; for example if money worries are major and a roommate disagreement is minor, only the money worries appear), and it is fine for a student to have themes in just one bucket or any mix (only bucket 1, only 3, or 1 and 2). It never outputs a severity label or score. This is in `prompts/v3/` and in the "Buckets" rule in `config/criteria.json`. When changing prompt wording, add a new `prompts/vN/` folder instead of editing an old one, so earlier runs stay reproducible.
- **No "New" / "Recurring" tags** on themes, and no qualifiers (taglines) next to the three bucket names (Emotional Burden, Skill & Knowledge Gaps, External Barriers). The list's column titles are centered over their columns.
- Sample or fictional transcripts are test data only. They are not a feature of the app (the upload files in `fixtures/upload/` are for trying it out).

## Workflow

- Separate branches and pull requests. Substantive changes need review by another teammate (function, clarity, handling of private data and credentials).
- Do not create accounts, push to a remote or touch AWS unless the project owner asks and is present.
- The project owner wants to give feedback early and often: stop at the agreed checkpoints and ask before moving on.

## Commands

`npm run dev`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run db:up`, `npm run db:down`.
