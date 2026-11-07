# Counselor Insights Prototype

A web tool for a student counselor who meets one-on-one with international students. The counselor adds a session (audio upload or pasted transcript). The tool transcribes it, finds the themes that actually came up, ties each theme to a verified quote, and suggests next steps.

**All data is fictional.** This is a class project (MSE203). Never put real student data anywhere in this repo, database or test set. The full build spec is in [`docs/SPEC.md`](docs/SPEC.md).

## Status

| Phase | What | State |
|---|---|---|
| 0 | Setup: repo, Next.js scaffold, Docker Postgres, lint, tests | Done |
| 1 | Text in, insights out (pasted transcripts, mock AI, screens) | Built, awaiting review |
| 2 | Audio upload and transcription | Built with local stand-ins, awaiting review |
| 3 | AWS deployment | Not started |

## Running locally

You need Node.js 22.12 or newer, Git, and Docker Desktop (running).

```bash
npm install
cp .env.example .env
```

Open `.env` and set `POSTGRES_PASSWORD` and `APP_DB_PASSWORD` to any passwords you make up. These are only for your local database. `.env` is git-ignored: never commit it.

Start the local database, create the tables, add the fictional demo data, then start the app:

```bash
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://localhost:3000 and use the **development login** (fake counselors "Alex Rivera", who has demo students, and "Sam Patel", who has none). The dev login only works for local development: it is switched on by `AUTH_MODE=dev` in `.env`, and the app refuses to run in production with it on. `npm run db:seed -- --reset` clears and re-adds the demo students. In the app, adding a session is a file upload: **audio recording** is the main option, and a **transcript file** (.txt or .json) is the alternative. Audio transcription is not connected until Phase 2, so to try the tool use the **Transcript file** tab and choose one of the five fictional files in `fixtures/upload/`. The mock AI then analyzes it.

`db:migrate` is safe to run again: it only applies new files from `migrations/`. The app connects as a limited `app_user` login so row-level security applies (a counselor can only see their own rows). Tests use a separate `<POSTGRES_DB>_test` database, so your dev data is never touched.

Open http://localhost:3000. Stop the database with `npm run db:down`.

If your terminal says `docker: command not found`, quit and reopen Docker Desktop and the terminal.

### Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Tests that use the database need `npm run db:up` first. `npm run build` sets `AUTH_MODE=off`: a production build refuses to run with the dev login on, by design.

### Running the analysis command

```bash
npm run analyze -- fixtures/transcripts/02-visa-fear.json
```

This runs both analysis calls on a transcript file and prints the verified result. It does not touch the database or the UI. Add `--json` for machine-readable output (logs go to stderr, so the JSON stays clean). A transcript file is a JSON array of `{ "speaker": "counselor" | "student", "text": "..." }`. Five fictional examples are in `fixtures/transcripts/` (the same text as `.txt` files for the upload box is in `fixtures/upload/`).

**The mock AI.** `.env.example` sets `LLM_MODE=mock`, so no AWS or API key is needed. For the five fixtures the mock returns hand-written results (in `fixtures/mock/`). For any other text it matches simple keywords and labels its output "(mock)". Real analysis with Claude on Amazon Bedrock is built but has **not yet been run against real AWS**: set `LLM_MODE` to anything other than `mock`, and set `BEDROCK_MODEL_ID` to a US-only inference profile id from the Bedrock console. Prompts live in `prompts/v3/` (selected by `PROMPT_VERSION`; older versions are kept so earlier runs can be reproduced); the taxonomy lives in `config/criteria.json`.

## Audio: how it works, and what is real

Adding a session by audio follows the spec: the browser asks the server for a link that lasts 15 minutes, sends the file straight to storage with one PUT (with a progress bar), then calls `POST /api/sessions/{id}/upload-complete`. The server checks the file is there, starts a transcription (speaker labels on, two speakers, English) and shows "Transcribing". When the transcript is ready the transcription service calls `POST /api/webhooks/assemblyai`, which needs the secret header and answers at once; the transcript is saved as utterances (the first speaker is the counselor, the other the student), and the analysis runs. If the webhook never arrives, **Check status** fetches the transcript. **Swap speakers** fixes wrong labels, then **Re-run analysis**. Recordings are accepted as MP3, M4A or WAV and are stored under `audio/{session id}.{ext}`, never with a name.

**Local stand-ins (the defaults in `.env.example`).** `STORAGE_MODE=local` keeps recordings in a git-ignored `.local-audio/` folder behind real signed, expiring links, and `TRANSCRIPTION_MODE=mock` returns one of the fictional transcripts, then calls the app's real webhook. The mock does not listen to the audio: it picks a transcript from a hidden marker in the file (or a hash of its contents), never from the file name. Try it with the silent placeholder files in `fixtures/audio/` (regenerate with `npm run fixtures:audio`). Both stand-ins are refused in a production build.

**Real S3 and AssemblyAI are written but have never been run.** They need accounts and keys, set up together step by step in [`docs/AWS_SETUP.md`](docs/AWS_SETUP.md). The AssemblyAI webhook cannot reach a computer at home, so it can only be tested after the deploy.

Deleting a student also deletes their recordings. Recordings are otherwise kept until deleted by hand (see "Audio retention").

## When the prototype ends

This is a class project, due **December 2, 2026**, and it is **switched off after December 15, 2026** (the end of that day, Pacific time). After that every page, form, upload and webhook call is refused (HTTP 410), nobody can sign in and no student data is shown. The date is `APP_ACTIVE_UNTIL`; if it is missing, December 15 applies, and a badly formed date switches the app off. This does **not** stop AWS charges or delete any data: see [`docs/SHUTDOWN.md`](docs/SHUTDOWN.md) for the teardown checklist.

## Deploying

The deployment is written but **has never been run**; no AWS account exists yet. It is set up together, step by step, in [`docs/AWS_SETUP.md`](docs/AWS_SETUP.md).

- **Container:** `Dockerfile` (a standard image: the app, plus a one-off migration runner `node dist/migrate.cjs`). Build it with `docker build -t counselor-insights .`
- **Infrastructure (AWS CDK, TypeScript):** `infra/`. One stack: network (no NAT gateway), RDS Postgres 16, the private audio bucket, Cognito, the load balancer with HTTPS, one Fargate task, alarms and CloudTrail, a role GitHub can use to deploy, and a scheduled scale to zero for December 16, 2026. `cd infra && npm install && npx cdk synth -c alertEmail=... -c cognitoDomainPrefix=... -c bedrockModelId=...` produces the CloudFormation template offline; `npm test` checks it.
- **Sign-in:** `AUTH_MODE=cognito` (AWS Cognito Managed Login, code flow with PKCE). Local development uses `AUTH_MODE=dev`, which is refused in a production build.
- **CI/CD (GitHub Actions):** `.github/workflows/ci.yml` runs lint, type check, tests and a build on every pull request; `deploy.yml` builds the image, runs the migrations as a one-off task and updates the service on a merge to `main`. It signs in to AWS with a short-lived token (OIDC), so no AWS keys are stored, and it does nothing until the repository variable `AWS_DEPLOY_ROLE_ARN` is set.
- **DNS:** `scripts/dns-records.sh` prints the two records to add by hand in Cloudflare. **Keys:** `scripts/store-secret.sh` stores them in Secrets Manager without them appearing anywhere.
- **Ending:** the app switches itself off after December 15, 2026 and the cloud teardown is in [`docs/SHUTDOWN.md`](docs/SHUTDOWN.md).

## Working on this project

Read the latest entries in [`WORK_LOG.md`](WORK_LOG.md) before changing anything, and add an entry after each meaningful change. See [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) for the rules for AI coding tools.

## Audio retention

Audio files are kept until the project ends and are deleted by hand. There is no automatic expiry.

## Known limits

- Speaker labels can be wrong on accented English and overlapping speech. A "Swap speakers" control is the fix.
- Transcription quality on accented English is untested until the team's recordings are run.
- Interpretations can sound plausible and be wrong. Quote checking proves a quote exists, not that the theme is right.
- Student names spoken in audio reach AssemblyAI and Claude. This is acceptable only because all data is fictional. It needs further work before any real use.
- Audio is kept until deleted by hand.
