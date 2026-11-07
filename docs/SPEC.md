# Counselor Insights Prototype: Build Spec for Claude Code

---

## 1. What we are building

A web tool for a student counselor who meets one-on-one with international students. The counselor uploads an audio file of a session. The tool transcribes it, finds the themes that actually came up in the conversation, ties each theme to a quote, and recommends next steps. The counselor uses it to track and understand what is going on with each student across sessions.

### Hard rules

1. **All data is fictional.** Student names, schools, notes and recordings are made up for a class project. Nothing in this repo, test set or database is a real person's data. Never ask for or accept real student data.
2. **Only themes that came up.** The tool does not evaluate every domain. If citizenship is never discussed, nothing about citizenship appears. There is no "not present" result.
3. **Every theme cites a real quote.** A theme with no verified quote is dropped.
4. **No student details go to the model.** Name, school, graduation year, country of origin and counselor notes are shown in the app but never sent to Claude. Claude sees only the transcript text (and, for call 2, earlier verified themes).
5. **No student details in logs.** Log IDs and event names only.
6. **No secrets in code, docs, issues or chat.** Use environment variables locally and AWS Secrets Manager when deployed.

---

## 2. Scope

### In scope
- Counselor login.
- Student records (name, school, graduation year, country of origin, free-text notes).
- Session creation by **audio upload** or **pasted transcript**.
- Transcription with speaker labels.
- Theme extraction against a preset, editable taxonomy (domains and sub-drivers).
- Next-step recommendations using this session and earlier sessions.
- Session view and a per-student view across sessions.
- Deployment to AWS at a subdomain of persimmon-care.com.

### Out of scope
- Recording audio in the browser (upload only).
- Eval scoring scripts (Krsna owns them, separate spec). This spec only makes sure the analysis step can be called on its own.
- Outbound calling, scheduling, texting, CGM data.
- HIPAA/BAA work, MFA enforcement, staging environment, canary deploys.
- A pixel-perfect copy of the earlier tracker. The same feel and structure is enough.
- Real students, real counselors' records or immigration status in any form.

---

## 3. Architecture and data flow

```
Counselor browser (Next.js app on ECS Fargate)
  1. Uploads audio file  ──presigned PUT──>  S3 (private bucket)
     or pastes a transcript (skips steps 1 to 3)
  2. App calls AssemblyAI with a presigned S3 link (speaker labels on)
  3. AssemblyAI calls the app's webhook when done
  4. App saves the transcript as utterances in RDS Postgres
  5. Call 1 (Claude on Bedrock): themes with quotes, plus crisis check
  6. Code verifies every quote against the stored utterances
  7. Call 2 (Claude on Bedrock): recommendations from this session
     and earlier sessions' verified themes
  8. Counselor reviews the session page and the student's running view
```

### Stack (all from the agreed vendor list)

| Layer | Choice | Notes |
|---|---|---|
| App | Next.js (TypeScript) with Tailwind CSS in a Docker container | Standard container, no vendor-specific runtime. |
| Hosting | AWS ECS Fargate behind an Application Load Balancer | One service, one task to start. |
| Audio storage | AWS S3 | Private, encrypted, no public access. |
| Transcription | AssemblyAI | General mode (not medical), English, speaker labels. |
| Database | AWS RDS PostgreSQL | Standard Postgres only. Migrations as SQL files in the repo. |
| Analysis | Claude on Amazon Bedrock | US-only inference. Not "Claude Platform on AWS". |
| Login | AWS Cognito | Admin-created users. Keep behind a thin module so it can swap to Clerk. |
| Secrets | AWS Secrets Manager | |
| Monitoring | CloudWatch (logs, a few alarms), CloudTrail | No transcript text in logs. |
| Infrastructure as code | AWS CDK (TypeScript) | |
| CI/CD | GitHub Actions to AWS using OIDC (no stored AWS keys) | |

Region: start in `us-west-2`. Confirm the chosen Claude models are available there. If not, use `us-east-1`. Use a US-only inference profile, never a "global" one.

Estimated cost for the class project: roughly $50 to $60 a month (Fargate and load balancer about $30, RDS about $15 or less, the rest pennies at this volume).

---

## 4. Data model

Use standard Postgres. UUID primary keys. All timestamps `timestamptz`.

| Table | Columns |
|---|---|
| `counselors` | id, cognito_sub (unique), email, display_name, created_at |
| `students` | id, counselor_id, full_name, school, graduation_year (int), country_of_origin, notes (text), created_at |
| `sessions` | id, student_id, counselor_id, session_date, status, source (`audio` or `pasted`), audio_s3_key (nullable), assemblyai_transcript_id (nullable), student_speaker_label, consent_confirmed_at (nullable), notes (text), error_message (nullable), current_analysis_run_id (nullable), created_at |
| `utterances` | id, session_id, idx (int, order), speaker (`counselor` or `student`), raw_speaker_label, start_ms (nullable), end_ms (nullable), text |
| `analysis_runs` | id, session_id, model_id, prompt_version, criteria_version, status, dropped_quote_count, crisis_flag (bool), created_at |
| `themes` | id, analysis_run_id, session_id, sub_driver_id (text), domain_id (text, copied from the config when saved), other_label (nullable), title, interpretation, created_at |
| `theme_evidence` | id, theme_id, utterance_id, quote (text) |
| `crisis_evidence` | id, analysis_run_id, utterance_id, quote (text) |
| `recommendations` | id, analysis_run_id, session_id, topic, open_question, suggested_approach, based_on_theme_ids (uuid[]) |
| `audit_events` | id, counselor_id, student_id (nullable), session_id (nullable), action, created_at |

**Session status values:** `created`, `awaiting_upload`, `uploaded`, `transcribing`, `transcribed`, `analyzing`, `complete`, `failed`. Pasted transcripts go straight from `created` to `transcribed`.

**Row-level security:** every table that has `counselor_id` (or reaches it through a session or student) gets a Postgres RLS policy so a counselor can only read and write their own rows. The app connects as a non-superuser role and sets `app.current_counselor_id` for each request. Include a test that proves counselor A cannot read counselor B's students, sessions or themes.

**Audit events:** write a row for upload, view of a session, view of a student, re-run of analysis, and delete. Student names never go in the `action` text.

Store each analysis run separately so re-running never overwrites earlier results. `sessions.current_analysis_run_id` points to the run shown in the UI. Record `model_id`, `prompt_version` and `criteria_version` on every run so results can be reproduced and compared.

---

## 5. Pipeline steps in detail

### Step 1. Uploading the audio
- Counselor opens a student and chooses "New session", then "Upload audio" or "Paste transcript".
- A checkbox "The student has consented to this recording" must be ticked. Save `consent_confirmed_at`.
- Server creates the session (`awaiting_upload`) and returns a presigned S3 PUT URL (expires in 15 minutes). The browser uploads directly to S3 with a progress bar. Accept `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/wav`. Sessions are about 10 to 15 minutes, so a single PUT is enough. No upload size limit beyond what the browser and S3 allow.
- S3 key: `audio/{session_id}.{ext}`. No names in keys or file names.
- Browser calls `POST /api/sessions/{id}/upload-complete`. Server checks the object exists (HeadObject), sets status `uploaded`.

### Step 2. Hosting the audio
- One private bucket. Block all public access. Default encryption on. Versioning off.
- CORS allows PUT from the app's hostname and from `http://localhost:3000`.
- **No lifecycle expiry.** Audio stays until the project ends and is deleted by hand. Put a one-line note about this in the README.

### Step 3. Transcribing the audio
- Server creates an AssemblyAI job using a presigned S3 GET URL (valid 1 hour), `speaker_labels` on, two speakers expected, English, and a webhook URL pointing at `POST /api/webhooks/assemblyai`.
- Protect the webhook with a secret header. AssemblyAI supports a custom auth header on webhooks. Reject requests that don't match. Confirm exact parameter names against current AssemblyAI docs.
- Set status `transcribing` and save `assemblyai_transcript_id`.
- On webhook: fetch the finished transcript from AssemblyAI, save its utterances (speaker, start and end times, text), set status `transcribed`, then start analysis. Return 200 right away and do the work after.
- Speaker mapping: the first speaker is labeled `counselor` and the other `student` by default. The session page has a one-click "Swap speakers" control that flips the mapping and re-labels the stored utterances. Wrong speaker labels are a known risk, and this is the fix.
- After saving, delete the transcript from AssemblyAI if the API allows it on our plan.
- Add a "Check status" button on the session page that fetches the transcript by ID in case the webhook never arrives.

### Step 4. Storing the transcript
- Utterances are the unit of storage. Each has an order index, a speaker, optional timestamps and text. This is what makes quote checking possible.
- Pasted transcripts: accept plain text where each line starts with `Counselor:` or `Student:`. Parse into utterances with no timestamps.
- Never log transcript text.

### Step 5. Pulling out insights (call 1)
See section 6.

### Step 6. Recommending next steps (call 2)
See section 6.

### Step 7. Counselor uses the tool
See section 7.

Analysis runs inside the Fargate app as an asynchronous job tracked by session status. Fargate has no function time limit. If the task restarts mid-run, the session shows `failed` and the counselor can press "Re-run analysis".

---

## 6. Analysis spec

### 6.1 Criteria config (the distress taxonomy)

The taxonomy is in Appendix A: three domains (Emotional Burden, Skill & Knowledge Gaps, External Barriers), each with sub-drivers. A theme is tagged with a **sub-driver**, and the domain is the group that sub-driver belongs to. Load it from `config/criteria.json` at startup, versioned by a `version` string. Seed the file from Appendix A with every sub-driver and all classification rules.

The taxonomy is **a vocabulary the model may draw from, not a checklist.** Editing it must not require a code change.

```json
{
  "version": "1.0",
  "domains": [
    { "id": "emotional_burden", "label": "Emotional Burden", "tagline": "How it feels" }
  ],
  "sub_drivers": [
    {
      "id": "homesickness_grief",
      "domain_id": "emotional_burden",
      "group": null,
      "label": "Homesickness and grief",
      "description": "Missing family and food, mourning a former role (\"I was somebody back home\")"
    }
  ],
  "classification_rules": [
    "Which domain: a feeling goes in Emotional Burden. ..."
  ]
}
```

- `group` is optional. External Barriers uses it for Rules & Institutions, Career & Network, and People & Community.
- The loader must accept extra fields.
- `classification_rules` are passed to call 1 word for word.
- The safety flag is not a sub-driver. It is handled separately (6.2 and 6.6).

### 6.2 Call 1: themes

**Input:** the stored utterances for one session, each with its ID, speaker and text, plus the criteria domains. Nothing else. No student details, no counselor notes.

**Instructions the prompt must carry:**
- Report only themes supported by what was said. If a sub-driver did not come up, say nothing about it.
- Tag each theme with one sub-driver from the taxonomy. The domain follows from it. If nothing fits, use `sub_driver_id: "other"` with a short `other_label`.
- Apply the classification rules in Appendix A. In particular, one statement can support themes in more than one domain (the visa test case), and Emotional Burden names only the feeling, never the cause.
- Pay attention to what sits under what is said (for example, "work is fine" after a hard story), but state it as an interpretation, not a fact.
- Never state or infer a student's actual immigration status in a title, interpretation or recommendation. Visa fear or visa confusion is tagged as a theme. When two quotes support a theme equally, prefer the one that does not state a status.
- Every theme must include one or more evidence items: an utterance ID and the exact quote from that utterance.
- Do not diagnose, label, or score. Do not give a severity.
- Separately, flag any crisis language (hopelessness, mention of self-harm) with its quote(s). This goes in its own field, not in themes.

**Output (structured JSON, validated):**

```json
{
  "themes": [
    {
      "sub_driver_id": "homesickness_grief",
      "other_label": null,
      "title": "Possible loss of professional identity",
      "interpretation": "The student may be feeling a drop in status after leaving a professional career.",
      "evidence": [{ "utterance_id": "…", "quote": "Back home I was an accountant, but it's fine." }]
    }
  ],
  "crisis": { "raised": false, "evidence": [] }
}
```

Use the Bedrock Converse API with a tool or schema that forces this JSON shape. Validate the response and retry once if invalid.

### 6.3 Quote verification (code, not the model)

For every evidence item:
1. The `utterance_id` must exist in this session.
2. After normalizing case, whitespace and punctuation on both sides, the quote must appear as a contiguous piece of that utterance's text.
3. A theme about the student should cite student utterances. If a quote is attributed to the wrong speaker, treat it as failed.

Drop any evidence that fails. Drop any theme left with no evidence. Count drops in `analysis_runs.dropped_quote_count`. Apply the same check to `crisis.evidence`. A crisis flag with no verified evidence is shown as "unverified" rather than dropped silently.

### 6.4 Call 2: recommendations

**Input:** this session's verified themes (title, domain, interpretation, quote) plus verified themes from the student's earlier sessions (session date, domain, title, interpretation). Not the full earlier transcripts, and no student details.

**Output:**

```json
{
  "recommendations": [
    {
      "topic": "Explore how the student feels about their work history",
      "open_question": "What did your work look like before you came here?",
      "suggested_approach": "Invite them to describe their former role before asking about current plans.",
      "based_on_theme_ids": ["…"]
    }
  ],
  "changes_since_earlier_sessions": ["Financial worries came up this session but not before."]
}
```

Recommendations are targeted at the themes that surfaced and read as suggestions, not instructions. They should fit the domain: for Emotional Burden, make room to explore the feeling; for Skill & Knowledge Gaps, teach the skill or point to a resource; for External Barriers, help navigate, refer or advocate. Return at most two recommendations, the most important ones. `based_on_theme_ids` must point to real themes. Drop any recommendation that doesn't. With a first session, `changes_since_earlier_sessions` is empty.

### 6.5 Model settings
- Default model: Haiku 5.5 on Bedrock. Sonnet 5.5 selectable through an environment variable (`BEDROCK_MODEL_ID`). Look up the exact model IDs in the Bedrock console.
- Prompts live as files in `prompts/` with a version string (`PROMPT_VERSION`). Never inline prompts in code.
- Bedrock prompt and response logging stays off.
- Temperature low (0 to 0.3). Make it configurable.
- Also provide an `LLM_MODE=mock` setting that returns canned JSON so tests run without AWS.
- All model calls go through one `LlmClient` interface with a provider setting (`LLM_PROVIDER`, default `bedrock`). Prompts, output schemas and quote verification do not depend on the provider. Build only the Bedrock implementation now.
- The course gives the team a Stanford AI API Gateway key ($300 usage limit). It does not work directly with model providers: requests go to the gateway's own endpoints in its own request format, described on the course usage page. A gateway adapter can be added later for cross-model evals. Store the key in Secrets Manager and never commit it.
- The course also provides OpenAI API credits to each team through a promotional link. These matter only for cross-model comparisons.

### 6.6 Crisis handling
If call 1 raises a crisis flag with verified evidence, the session page shows a prominent banner above everything else with the quote(s) and the text: "Possible crisis language. Review the quote and use your own judgment and your school's process. This tool is not a screening tool." The flag is saved on the analysis run.

### 6.7 Run analysis on a bare transcript
Provide a command `npm run analyze -- <path-to-transcript.json>` that runs calls 1 and 2 on a transcript fixture without touching the database or the UI, and prints the verified result. Fixture format: a JSON array of `{ "speaker": "counselor" | "student", "text": "…" }`. Krsna's eval scripts will build on this.

---

## 7. Look and feel and screens

The interface follows the earlier Clinician Conversation Tracker, live at tracker.persimmon-care.com. The goal is the same feel and structure, not a pixel copy. If screenshots of that app are provided, match them. Otherwise follow this section. Use Tailwind CSS with the tokens below.

### 7.1 Feel

Calm, clinical, uncluttered. It should read as a working tool for a busy counselor, not a consumer wellness app. Warm off-white background, white cards with hairline borders, one warm orange accent, lots of whitespace, and small uppercase labels over plain sentence-case body text. No gradients, heavy shadows or illustrations, and no icons beyond a few small utility ones (funnel, sort arrow, warning triangle). Copy is plain and non-alarming, for example "Suggestions for the counselor to confirm and adapt."

### 7.2 Design tokens

| Token | Value | Use |
|---|---|---|
| canvas | `#faf9f7` | Page background |
| surface | `#ffffff` | Cards, header, footer |
| ink | `#1f2933` | Primary text |
| muted | `#5f6c7b` | Secondary text, labels, dates |
| line | `#e4e7eb` | All borders and dividers (1px) |
| accent | `#e8702a` | Primary buttons, brand dot, quote bars |
| accent-dark | `#c85a1b` | Button hover, link text, small-caps labels in accent |
| accent-soft | `#fdf1e8` | Highlight panels, row hover, processing banner |

Font: system sans stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto`). No webfonts.

**Chips** are pill-shaped, `text-xs font-medium`, pale background with darker text of the same hue.

| Tone | Colors | Use |
|---|---|---|
| neutral | stone-100 / stone-700 | Sub-driver tags |
| accent | accent-soft / accent-dark | "Edited by counselor" |
| green | emerald-50 / emerald-700 | "New": the theme's sub-driver did not appear in any earlier session |
| blue | sky-50 / sky-700 | "Recurring": the sub-driver appeared in an earlier session |
| red | red-50 / red-700 | Crisis markers only |

### 7.3 Layout and spacing

- Page container: max width 6xl (about 1152px), 16px side padding, 24px vertical padding. Header is 56px tall.
- Header: white with a bottom hairline border. Left: a 14px accent-colored dot, then the product name in semibold large text (set through `APP_NAME`, "International Student Counseling"). Right: the counselor's name and an initial avatar.
- Footer: white with a top hairline border, centered extra-small muted text: "Prototype. Use fake data only."
- Vertical rhythm between major sections is 24px. Inside cards it is 8 to 16px.
- The student page is a two-column grid at 3fr / 2fr on desktop (themes left, recommendations right). It collapses to one column on small screens. Table column headers hide on mobile.

### 7.4 Component patterns

- **Section card:** white, rounded-xl, 1px line border, 20px padding. Heading is `text-lg font-semibold`.
- **Inner card (domain card):** rounded-lg, 1px line border, 16px padding, no fill.
- **Focus-area card (recommendation):** rounded-xl with an accent border at 30% opacity. A small uppercase accent label, then a semibold title, a muted context line, and sub-sections.
- **Small-caps label:** `text-xs font-semibold uppercase tracking-wide`, muted (accent-dark when it labels the key idea of a section). Used for column headers and sub-section labels such as "Conversation starters".
- **Highlight panel:** accent-soft fill, rounded-lg, a small accent-dark uppercase label, and a bulleted list.
- **Quote:** 2px left border in accent at 40% opacity, 12px left padding, curly quotes, then a muted date such as "· Nov 6, 2026". Quotes sit behind a collapsible "Evidence (N quotes)" summary in muted small text, collapsed by default.
- **Primary button:** accent fill, white text, rounded-lg, `px-4 py-2 text-sm font-medium`, darker on hover, 60% opacity when disabled.
- **Secondary button:** white fill, line border, rounded-md, small text.
- **Text links and inline actions:** `text-xs`, muted, underline on hover. The main action (Edit) is accent-dark and medium weight.
- **Inputs:** full width, rounded-lg, line border, `px-3 py-2 text-sm`, focus ring in accent at 40%. Labels sit above the input in `text-sm font-medium`, with a red asterisk on required fields. Helper text is extra-small and muted.
- **Table-like list:** not a real table. A white rounded-xl bordered list with `divide-y`. Each row is a full-width link on a CSS grid with a soft-accent hover. Column headers sit above the list in small-caps muted text. Funnel icons open small dropdown filters. A sort arrow sits on "Last session".
- **Empty state:** dashed-border white rounded-xl card with centered muted text, followed by a primary button.
- **Processing banner:** accent-soft fill, accent border at 40%, a pulsing accent dot, a bold title and a muted explanation. The page polls and updates itself.
- **Crisis banner:** red-50 fill, red-200 border, dark red text, `role="alert"`. A semibold title, then the flagged quote(s) in italics with a red left border. It sits at the top of the student page.
- **Warning marker:** a small red "⚠" next to a student's name in the list when the latest completed session has a crisis flag.

### 7.5 Pages

**1. Login.** Hosted by Cognito. On first sign-in, create the `counselors` row.

**2. Student list.** A small accent caps label "COUNSELOR ACCOUNT", then an H1 "{Name}'s students" (`text-2xl font-semibold`) with the email line under it, and a primary "New Student" button on the right. Below that, the table-like list with columns Name, School, Graduation year, Country, Sessions, Last session. Funnel filters on School and Country, a sort arrow on Last session. Empty state when there are no students.

**3. New student.** One narrow, centered form. Fields in this order: full name; school and graduation year side by side; country of origin; notes; audio file (MP3, M4A or WAV) with a "Paste transcript instead" option; session date; and a consent checkbox, "The student has consented to this recording" (required for audio, saved with a timestamp). One primary submit button. It creates the student and the first session.

**4. Student page** (everything for one student on one page), top to bottom:
1. "← Students" muted link.
2. Crisis banner, if the latest analysis raised a flag. It shows the verified quote(s) and the text "Review the quote and use your own judgment and your school's process. This tool is not a screening tool." If the evidence could not be verified, say so in the banner.
3. Student summary card: the same columns as the list, then the notes.
4. Processing banner while a session is uploading, transcribing or analyzing.
5. Two columns.
   - **Left, "Distress profile":** a highlight panel listing the themes found in the most recent session, then one domain card per domain that has themes. Domains with no themes are not shown. Inside a domain card, each theme shows a neutral sub-driver chip, a "New" or "Recurring" chip, a semibold title, the interpretation, and a collapsed "Evidence (N quotes)" section. Clicking a quote opens the session page at that line.
   - **Right, "Recommendations for next session":** at most two focus-area cards. Each has a small uppercase accent label "FOCUS AREA", a semibold title (the topic), a muted context line (the sub-drivers it is based on, plus any "changes since earlier sessions" note), and two sub-sections: "Conversation starters" (the open question) and "Suggested approach". Under the cards, an "Add a session" card with the audio or pasted-transcript option, session date and consent checkbox.
6. Session history card: one row per session with date, source (audio or pasted), a status chip, and a link to the session page.
7. A small, muted "Delete student" action, centered at the very bottom.

**5. Session page** (secondary, needed for the transcript and fixes). "← {Student name}" link, status line with "Check status" and "Re-run analysis" buttons, the transcript with speaker labels and a "Swap speakers" control, session notes, and the same quote format. Same styling as above.

### 7.6 Interaction rules

- One page per student. No modals and no sidebars. The session page is the only second level.
- Confirmations use the browser's native `confirm()`.
- Evidence is collapsed by default so the page stays scannable. Detail is one click away.
- Status is shown with chips and one banner, never by color alone. Text labels are always present.
- Destructive actions are small, muted, and sit at the edges of cards.
- Counselor notes (on the student and on the session) are display-only and never passed to the analysis.

### 7.7 Optional, build last: edit mode

Each theme card can switch in place to edit mode: the text becomes a textarea, the sub-driver shows as removable tag pills (with ×) and a dashed "+ Add tag" select, with Save (primary, small) and Cancel (secondary, small). After saving, an "Edited by counselor" chip appears with "Show AI version" and "Revert to AI version" links. This needs the original model output kept next to the edited version. Build it only if the rest is done.

---

## 8. Auth and access

- Cognito user pool, **admin-created users only** (no self sign-up), email and password. MFA optional and off for the prototype.
- Login through Cognito Managed Login (hosted UI), authorization code flow with PKCE. Verify tokens on the server (for example with `aws-jwt-verify`) and keep the session in an httpOnly cookie.
- Put all auth behind one small module (`lib/auth`) so it can be swapped for Clerk if Cognito fights back. Build Cognito on a branch first with fake users. If it works cleanly, merge it.
- Callback and sign-out URLs: the app's hostname and `http://localhost:3000`.
- Local development may use a clearly marked dev-only login bypass that is impossible to enable in a deployed build.
- No in-app admin. Create users in the Cognito console. Reviewer counselors are just more counselors.

---

## 9. Security and privacy rules

- S3: block public access, encryption on, access only through presigned URLs.
- RDS: not publicly reachable, encrypted, automated backups on (7 days), single instance.
- HTTPS only. Redirect HTTP to HTTPS at the load balancer.
- Secrets (database credentials, AssemblyAI key, webhook secret) in Secrets Manager, read by the ECS task role. Least-privilege IAM.
- Logs: IDs and event names only. Never transcripts, quotes, names, schools, countries or notes. Include a test that seeds fake student names and quotes, runs the pipeline, and fails if any appear in captured log output.
- Test that the exact payload sent to Bedrock contains no field from the student record or any counselor note.
- Transcripts can contain names the student says aloud. These go to AssemblyAI and to Claude. This is acceptable only because all data is fictional. Note it in the README as a limit before any real use.
- GitHub: private repo, secret scanning on, PR review before merge.

---

## 10. Infrastructure (AWS CDK)

Stacks or constructs for:
- **Network:** VPC. RDS in isolated subnets. Fargate tasks in public subnets with public IPs and tight security groups, to avoid the cost of a NAT gateway. Add an S3 gateway endpoint. (If a NAT gateway is preferred later, it's a small change.)
- **Database:** RDS Postgres 16, small instance class, single AZ, encrypted, credentials in Secrets Manager.
- **Storage:** the audio bucket described above.
- **Cognito:** user pool, app client, Managed Login domain.
- **App:** ECR repository, ECS cluster, Fargate service (one task to start), ALB with HTTPS listener, health-check endpoint `/healthz` that returns no data about students.
- **Task role:** read and write on the audio bucket, invoke Bedrock models, read specific secrets. Nothing else.
- **Monitoring:** CloudWatch log group with 30-day retention, alarms for task restarts and 5xx errors with email notification, CloudTrail enabled.
- **Config:** `APP_HOSTNAME` as a stack parameter, default `studentcounseling.persimmon-care.com`.

### Domain and HTTPS
The app lives at `studentcounseling.persimmon-care.com`, set through the `APP_HOSTNAME` parameter rather than hard-coded. The existing `tracker.persimmon-care.com` record for the individual project, and any other existing record, must not be touched.

Request an ACM certificate for the hostname with DNS validation. DNS for persimmon-care.com is believed to be managed in Cloudflare (the domain is also connected to Vercel for the individual project, which this project does not use). Audrey adds two records by hand in Cloudflare, and Claude Code does not need DNS credentials:
1. The ACM validation CNAME that the CDK output prints.
2. A CNAME for `studentcounseling` pointing at the load balancer's DNS name, also printed by the CDK output.

Both records must be set to **DNS only** (grey cloud), not proxied, so certificate validation and the AssemblyAI webhook work without Cloudflare in the path. Before adding anything, Audrey checks the DNS page for persimmon-care.com in Cloudflare and confirms the domain's nameservers are Cloudflare's. If DNS turns out to be managed in Vercel instead, the same two records go there.

---

## 11. CI/CD and team conventions

- **GitHub Actions:** on pull request run lint, type check and tests. On merge to `main`: build the image, push to ECR, run database migrations as a one-off ECS task, update the ECS service. Authenticate to AWS with OIDC and short-lived credentials.
- **Migrations:** SQL files in the repo, applied in order. Any standard migration tool is fine. RLS policies are part of the migrations.
- **One environment** plus local development (Docker Postgres). No staging, no canary.
- **Repo files to create at the start:**
  - `README.md`: setup, running locally, running the analysis command, deploying, and the audio retention note.
  - `WORK_LOG.md`: one entry per meaningful change with timestamp and time zone, author, summary, affected components, verification performed, and blockers or handoff notes. Commit each entry with the change it describes.
  - `AGENTS.md` and `CLAUDE.md`: both tell AI coding tools to read recent `WORK_LOG.md` entries before changing anything, preserve teammates' work, and update the log after meaningful changes. Both reference the same work log and the same rules.
- Separate branches and pull requests. Substantive changes need review by another teammate. Reviews check function, clarity, and handling of private data and credentials.
- Fake data only while building with Claude Code.

---

## 12. Build order

**Phase 0. Setup.** Repo, `README.md`, `WORK_LOG.md`, `AGENTS.md`, `CLAUDE.md`, Next.js scaffold, Docker Postgres, linting, test runner.

**Phase 1. Text in, insights out.** Database and migrations with RLS. Criteria config and loader. Pasted-transcript path. Calls 1 and 2, quote verification, crisis handling. `npm run analyze`. The screens in section 7 (pasted transcripts only, no upload yet). Local dev login bypass. Fixtures: at least 3 fictional transcripts with different themes, one with crisis language, one with a theme outside the taxonomy, one with visa fear (to test tagging across domains), and one where the student states an immigration status (the status must not appear in any theme or recommendation). All tests in section 13 that don't need AWS.

**Phase 2. Audio.** S3 upload with presigned URL, AssemblyAI job and webhook, speaker swap, status handling, "Check status" and "Re-run analysis".

**Phase 3. Deploy.** CDK stacks, Cognito on a branch, ALB with HTTPS on the subdomain, secrets, CI/CD, CloudWatch. Start as soon as Phase 1 runs locally so teammates can reach a hosted URL.

Team targets: working text-in version and test transcripts by Monday; recorded interviews uploaded by the end of the weekend; evals Monday and Tuesday; midterm due Wednesday Nov 11.

---

## 13. Tests to include

- Quote verifier: exact match passes; altered quote fails; quote from the wrong speaker fails; theme with no valid evidence is dropped.
- Transcript parser for pasted text.
- Criteria loader reads domains, groups and sub-drivers, accepts extra fields, and accepts an edited list.
- Pipeline test with mocked AssemblyAI and mocked Bedrock (`LLM_MODE=mock`).
- RLS test across two counselors.
- Bedrock payload contains none of the student record fields or notes.
- Log-capture test shows no names, quotes or notes.
- Webhook rejects a missing or wrong secret header.
- Swap speakers flips labels on stored utterances.

---

## 14. First-time AWS setup

Audrey has not used AWS before. **Claude Code: walk her through these steps one at a time, in plain language, and confirm each one worked before moving on.** Write the steps up as `docs/AWS_SETUP.md`. Never ask her to paste AWS keys, passwords or the AssemblyAI key into chat, a file or the repo. Never use or request root-user access keys.

1. **Create the AWS account** at aws.amazon.com with a payment method.
2. **Secure the root user.** Turn on MFA with an authenticator app. Do not create access keys for root, and do not use root for day-to-day work.
3. **Set a budget alert.** In AWS Budgets, create a monthly budget (suggested $75) with email alerts at 50%, 80% and 100%.
4. **Create a daily-use admin.** Use IAM Identity Center (or an IAM user with MFA) with administrator permissions, then set up the AWS CLI with a profile (`aws configure sso`). Confirm with `aws sts get-caller-identity`.
5. **Choose the region** `us-west-2` in the console and CLI profile.
6. **Request Bedrock model access** for the Claude models used (Haiku 5.5 and Sonnet 5.5). AWS may ask for a short use-case form, and approval can take a little time. Claude Code checks current AWS documentation for the exact steps.
7. **Bootstrap and deploy.** Run `cdk bootstrap` once, then `cdk deploy`.
8. **Store the AssemblyAI key.** Audrey creates an AssemblyAI account and API key. Claude Code provides a command that prompts for the key and saves it to Secrets Manager, so the key never appears in chat or files.
9. **Add the two DNS records in Cloudflare** described in section 10.

---

## 15. Things a human has to do (not Claude Code)

| Who | Task |
|---|---|
| Audrey | Complete the AWS setup in section 14 with Claude Code's guidance. |
| Audrey | Create an AssemblyAI account and API key. |
| Audrey | Add the two DNS records for `studentcounseling.persimmon-care.com` in Cloudflare. |
| Audrey | Create the private GitHub repo and add teammates. |
| Troy | Keep `config/criteria.json` in step with the taxonomy in Appendix A. Later edits go in the config file, not in code. |
| Krsna | Own the eval scoring spec and scripts, building on `npm run analyze`. |
| Team | Write fictional transcripts, record them as audio, and keep consent wording ready for the mock sessions. |

## 16. Known limits to state in the README

- Speaker labels can be wrong on accented English and overlapping speech. The swap control is the fix.
- Transcription quality on accented English is untested until the team's recordings are run.
- Interpretations can sound plausible and be wrong. Quote checking proves a quote exists, not that the theme is right.
- Crisis detection is an aid. A missed case is possible. It is never a screening tool.
- Student names spoken in audio reach AssemblyAI and Claude. Fine for fictional data, not for real use without further work.
- Audio is kept until deleted by hand.

---

## Appendix A. Distress taxonomy: international student acclimating to the U.S.

Three domains, each with sub-drivers. A tag on a transcript names the sub-driver, and the domain is the group it belongs to. Use these ids (snake_case of the label) when seeding `config/criteria.json`.

### Emotional Burden (how it feels)
- **Homesickness and grief:** missing family and food, mourning a former role ("I was somebody back home")
- **Loneliness:** eating alone, having no one to call when something goes wrong
- **Shame and embarrassment:** mortified after a mistake in class, hiding that they are struggling
- **Guilt:** feeling they are wasting what the family sacrificed, enjoying life while family struggles back home
- **Self-doubt:** "everyone else belongs here but me," wondering if they were admitted by mistake
- **Fear and anxiety:** dread of failing a class, losing visa status, or having no job after graduation
- **Frustration and resentment:** anger at confusing systems, at being treated as an outsider
- **Exhaustion and burnout:** constantly translating and adapting, running on little sleep

### Skill & Knowledge Gaps (they don't know how)
- **English comprehension and expression**
- **Cultural and social norms**
- **Academic norms:** participation, office hours, writing and citation
- **Career norms:** how to write a U.S. resume, interview, network
- **Daily-life systems:** how to open a bank account, find housing, use insurance, get around
- **Visa and work rules:** what is and is not allowed, how to keep status
- **Money management:** how credit, budgeting and taxes work
- **Self-advocacy:** how to ask for help and speak up for their needs with anyone (professors, landlords, doctors, offices, employers)
- **Study and time management**

### External Barriers (they know how, but something outside blocks them)

Group: Rules & Institutions
- **Visa and work restrictions:** limits on working, earning or traveling
- **Institutional bureaucracy:** slow or conflicting answers from offices and advisors
- **Program and funding requirements:** GPA or enrollment minimums
- **Financial strain:** tuition, living costs, unexpected expenses

Group: Career & Network
- **Job market access:** few roles open to international students, employers unwilling to sponsor
- **Professional network:** no contacts, mentors or alumni access
- **Credential recognition:** home-country degrees or experience not valued

Group: People & Community
- **Social support:** no local network
- **Discrimination and exclusion**
- **Interpersonal conflict:** roommates, groupmates
- **Family obligations:** caregiving, financial support, crisis back home
- **Help-seeking stigma:** from family, peers or culture
- **Living conditions:** unsafe, unstable or hard-to-reach housing, food, transport, healthcare

### Classification rules
- **Which domain:** a feeling goes in Emotional Burden. "I don't know how" goes in Skill & Knowledge Gaps. "I know how, but I can't, or it isn't there" goes in External Barriers.
- **Emotion vs. cause:** Emotional Burden names only the feeling. The cause comes from the other two domains.
- **Visa test case:** the fear is Fear and anxiety, not understanding the rules is a Skill & Knowledge Gap, and the restrictions are Visa and work restrictions.
- **Employer vs. system:** an employer refusing to sponsor is Job market access. The visa rule itself is Visa and work restrictions.
- **Professional vs. personal:** career contacts are Professional network. Friends, family and local support are Social support.
- **Safety flag:** crisis signals are a separate flag on any transcript, not a sub-driver.
- **Privacy:** the tool tags visa fear as a theme and never records an actual immigration status.
