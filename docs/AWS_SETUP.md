# First-time AWS setup (a guide for Audrey)

You have not used AWS before, so this walks through it one step at a time, in plain language. **Nothing here has been done yet.** Do each step yourself, tell Claude Code when it is done, and it will check that it worked before the next step.

## Rules for the whole thing

- **Never paste an AWS key, a password or the AssemblyAI key into chat, a file or the repo.** Step 8 has a script that asks for the AssemblyAI key in your own terminal and sends it straight to AWS.
- Never create or use access keys for the root user (the account's all-powerful login).
- AWS shows screens that change over time. If a screen does not match this guide, stop and tell Claude Code what you see.

## What is already built, and what AWS adds

Everything runs on your computer today, using stand-ins. AWS replaces them:

| On your computer now | On AWS (needs this guide) |
|---|---|
| A folder for recordings (`.local-audio/`) | A private **S3** bucket. Recordings are sent to it with links that last 15 minutes. |
| A fake transcriber that calls the app's webhook | **AssemblyAI** (a separate company, separate account, step 8) calling the same webhook |
| A fake AI with canned answers | **Claude on Amazon Bedrock** (step 6) |
| A fake login | **Cognito** login |
| `npm run dev` | The app running on **ECS Fargate** behind a load balancer (Phase 3) |

The S3, AssemblyAI and Bedrock code is written but has **never been run for real**. Expect to fix small things the first time.

## The steps

### 1. Create the AWS account
Go to aws.amazon.com and create an account with a payment method. Expect roughly **$50 to $60 a month** while the project is deployed (the load balancer and the app server are most of it).

### 2. Secure the root user
Sign in as the root user once. Turn on **multi-factor authentication (MFA)** with an authenticator app. Do not create access keys for root and do not use root for day-to-day work.

> **Decision (Nov 7, 2026): MFA on the root user was skipped.** This is a class project with fictional data, and the account's free plan blocked the usual security-credentials page. The risk accepted is an attacker who learns the password running up charges on the card or changing the account. Minimum protections instead: a long unique password kept in a password manager; never any access keys for the root user; and the budget alert (step 3) switched on, with its emails actually read. (This is separate from the app's own MFA for counselors, which the spec keeps off.)

> **Free plan note:** the account is on AWS's free plan ($100 credits, about 6 months). Do **not** turn on IAM Identity Center or join AWS Organizations: reports say either can move the account off the free plan. Step 4 therefore uses an ordinary IAM admin user, not Identity Center.

### 3. Set a budget alert
In **AWS Budgets**, create a monthly **cost budget of $25** with email alerts at **50%, 80% and 100%** (that is $12.50, $20 and $25). Send the alerts to an email you actually read. A budget **warns you but does not stop spending**; AWS keeps running (and billing) after the alert.

**Heads up:** $25 is below the roughly $50 to $60 a month it costs to keep the whole deployed app running (the load balancer and the app server are most of it). So once the app is deployed and left on, expect the alerts to fire during the month. That is by design: they tell you the project is costing more than your limit. Until Phase 3 is deployed there is almost nothing to pay for. When the app is not being used, ask Claude Code to tear the stack down (`cdk destroy`) and redeploy it later; we will check what that deletes (the database, for example) before doing it.

### 4. Create a daily-use admin
We use **`aws login --region us-east-2`** signed in as the account's root user (temporary credentials, up to 12 hours; run `aws logout` when done). It needs no access key. Confirm with:

```bash
aws sts get-caller-identity
```

It should show your own account number. Tell Claude Code the result.

### 5. Choose the region
Use **us-east-2** (Ohio) in the console and in the CLI profile: AWS fixed your project "Rubber Ducking" to that region when the account was made, and `aws login` refuses any other. If the Claude models you need are not offered there (step 6), tell me before changing anything. Always use a **US-only** model setting, never a "global" one.

### 6. Request Bedrock model access
In the **Amazon Bedrock** console, open the model catalog and choose the Claude models we use (Haiku 5.5, and Sonnet 5.5 as the alternative). Anthropic models ask for a short **use-case form** the first time, once per account; access is normally granted right away. AWS may also ask you to accept a Marketplace agreement. The exact screens change, so follow what the console shows and tell Claude Code if anything looks different.

Then find the exact **model ID** (a US-only "inference profile" ID) in the console. It goes in `BEDROCK_MODEL_ID`. Do not guess it. Also confirm Bedrock's **prompt and response logging is off**.

### 7. Bootstrap and deploy

**Do step 8 first**: the app reads its secrets when it starts. The infrastructure code is in `infra/` (run `npm install` there once). Nothing below has been run yet.

1. `cdk bootstrap` once, from `infra/`.
2. **First deploy, with no app running yet** (there is no image to run). Claude Code fills in the settings with you; none of them is a secret:
   ```bash
   cdk deploy -c alertEmail=you@example.com -c cognitoDomainPrefix=your-unique-name \
     -c bedrockModelId=<the US-only id from step 6> -c githubRepo=owner/name -c desiredCount=0
   ```
   `githubRepo` is optional until the private repository exists. If a setting is missing or wrong, it stops with a plain list of what to fix. **The deploy pauses at the certificate** until the validation record from step 9 is added, so open a second terminal and run `scripts/dns-records.sh` while it waits. AWS also emails you once to **confirm the alarm email**.
3. **Create the first counselor** in the Cognito console (the user pool in the deploy output, then Users, then Create user: an email and a temporary password). There is no sign-up page; every account is made this way.
4. **Connect GitHub.** Put the deploy output `GithubDeployRoleArn` into the repository variable `AWS_DEPLOY_ROLE_ARN` (GitHub, Settings, Secrets and variables, Actions, Variables). It is not a secret. A merge to `main` then builds the image, runs the database migrations as a one-off task, and updates the service. (No AWS keys are ever stored in GitHub.)
5. **Start the app:** once that first workflow run has pushed an image, run the same `cdk deploy` again **without** `-c desiredCount=0`.

The deploy output also prints `DeactivatesAfter` and `ScaledToZeroAt`: the app switches itself off after December 15, 2026 and its server is scaled to zero at that moment. See `SHUTDOWN.md`.

### 8. Store the keys safely (before step 7's first start)
1. Create an **AssemblyAI** account and an API key (a separate company; free to start).
2. In your own terminal, run:
   ```bash
   scripts/store-secret.sh assemblyai-key
   scripts/store-secret.sh webhook-secret
   ```
   The first asks you to paste the key (nothing shows as you type) and sends it straight to **AWS Secrets Manager**. The second makes up a random secret itself. Neither value ever appears in chat, in a file or in your shell history. (Add `--dry-run` to see what a command would do without touching AWS.)

### 9. Add two DNS records in Cloudflare
During the first deploy, run `scripts/dns-records.sh` (it only reads from AWS and changes nothing). It prints both records. In Cloudflare, for `persimmon-care.com` (first check that the domain's nameservers really are Cloudflare's; if DNS is at Vercel instead, add them there), add:
1. the **certificate validation CNAME** (this lets the deploy continue), and
2. a **CNAME** for `studentcounseling` pointing at the load balancer's address.

Set both to **DNS only (grey cloud)**, not proxied, so the certificate check and AssemblyAI's webhook can reach the app. **Do not touch the existing `tracker` record or any other record.**

## Things that need this setup before they can be tested for real

- Uploading a recording to a real S3 bucket (the bucket must allow PUT from the app's address and from `http://localhost:3000`, with no public access).
- AssemblyAI transcribing it, and calling the webhook. AssemblyAI cannot reach your computer, so this is tested after the deploy, on the real address.
- Claude on Bedrock analysing a transcript. Whether the prompts give good results is still unknown.
- Whether AssemblyAI lets us delete a transcript on our plan (the app tries, and ignores a refusal).

## When the project ends

The app switches itself off after **December 15, 2026**, but that does not stop AWS charges or delete data. The teardown checklist is in [`SHUTDOWN.md`](SHUTDOWN.md). The cloud setup (Phase 3) must include a scheduled scale-to-zero for December 16 so cost stops even if nobody remembers.

## Audio retention

Recordings stay in the bucket until the project ends and are deleted **by hand**: there is no automatic expiry. Deleting a student in the app also deletes that student's recordings.

> **Model used (tested 2026-11-07):** on this free-plan account only some Claude models can be called. `us.anthropic.claude-sonnet-4-6` works and is the one we deploy with (`-c bedrockModelId=us.anthropic.claude-sonnet-4-6`). The 5.x models were refused. Re-test with a tiny fictional prompt before changing it.
